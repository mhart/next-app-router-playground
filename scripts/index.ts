import { Readable } from 'node:stream';

import type { NextConfig } from 'next';
import {
  NodeNextRequest,
  NodeNextResponse,
} from 'next/dist/server/base-http/node';
import { MockedResponse } from 'next/dist/server/lib/mock-request';
import NextNodeServer, {
  NodeRequestHandler,
} from 'next/dist/server/next-server';
import type { IncomingMessage } from 'node:http';
import {
  createPprResponse,
  getCachedResponse,
  internalFetch,
  isrPut,
  NON_BODY_RESPONSES,
  ssgPut,
} from './cache';

const textEncoder = new TextEncoder();

const routeManifest = (globalThis as any).ROUTES_MANIFEST as {
  staticRoutes: { page: string; regex: string }[];
  dynamicRoutes: { page: string; regex: string }[];
  rsc: { contentTypeHeader: string; varyHeader: string };
};

// Injected at build time
const nextConfig: NextConfig = JSON.parse(
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG ?? '{}',
);

let requestHandler: NodeRequestHandler | null = null;

globalThis.addEventListener('error', (event: ErrorEvent) => {
  console.error('globalThis.addEventListener error');
  console.error(event.error);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (requestHandler == null) {
      const strEnv = Object.fromEntries(
        Object.entries(env).filter(([_, v]) => typeof v === 'string'),
      );
      globalThis.process.env = { ...globalThis.process.env, ...strEnv };
      requestHandler = new NextNodeServer({
        conf: { ...nextConfig, env: strEnv },
        customServer: false,
        dev: false,
        dir: '',
        minimalMode: true,
      }).getRequestHandler();
    }

    (globalThis as any).INTERNAL_FETCH = async (
      input: RequestInfo | URL,
      init: RequestInit,
    ) => {
      try {
        return await internalFetch(env.CACHE, input, init);
      } catch (e) {
        console.error(e);
        throw e;
      }
    };

    (globalThis as any).ASSET_READ = async (path: string) =>
      (await env.ASSETS.fetch('http://assets/cdn-cgi/' + path)).text();

    const url = new URL(request.url);

    if (url.pathname === '/_next/image') {
      let imageUrl =
        url.searchParams.get('url') ??
        'https://developers.cloudflare.com/_astro/logo.BU9hiExz.svg';
      if (imageUrl.startsWith('/')) {
        return env.ASSETS.fetch('http://assets' + imageUrl, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
      }
      return fetch(imageUrl, { cf: { cacheEverything: true } } as any);
    }

    const matchedPath = getMatchedPath(request);

    const { cacheKey, prerender, cacheResponse } = await getCachedResponse(
      request,
      env,
      routeManifest,
    );

    if (cacheResponse != null) {
      // Handle PPR
      if (prerender.experimentalPPR) {
        return createPprResponse(
          request,
          ctx,
          cacheKey,
          cacheResponse,
          requestHandler,
          getNextResponse,
        );
      }

      // Handle SSG
      if (
        cacheResponse.headers.get('x-nextjs-cache') === 'PRERENDER' &&
        prerender.initialRevalidateSeconds === false
      ) {
        ctx.waitUntil(ssgPut(env, cacheKey, cacheResponse));

        // Handle ISR
      } else if (
        ['STALE', 'PRERENDER'].includes(
          cacheResponse.headers.get('x-nextjs-cache') ?? '',
        )
      ) {
        ctx.waitUntil(
          isrPut(
            request,
            env,
            ctx,
            cacheKey,
            cacheResponse,
            prerender.dataRoute,
            requestHandler,
            getNextResponse,
          ),
        );
      }

      return cacheResponse;
    }

    return getNextResponse(request, ctx, matchedPath, requestHandler);
  },
};

function getMatchedPath(request: Request) {
  const url = new URL(request.url);

  let matchedPath = '';
  for (const route of routeManifest.staticRoutes) {
    if (new RegExp(route.regex).test(url.pathname)) {
      matchedPath = route.page;
      break;
    }
  }
  if (!matchedPath) {
    for (const route of routeManifest.dynamicRoutes) {
      if (new RegExp(route.regex).test(url.pathname)) {
        matchedPath = route.page;
        break;
      }
    }
  }

  const isRscRequest =
    !!request.headers.get('rsc') || url.pathname.endsWith('.rsc');

  if (matchedPath && isRscRequest && !matchedPath.endsWith('.rsc')) {
    matchedPath = url.pathname === '/' ? '/index.rsc' : matchedPath + '.rsc';
  }

  return matchedPath;
}

async function getNextResponse(
  request: Request,
  ctx: ExecutionContext,
  matchedPath: string,
  requestHandler: NodeRequestHandler,
) {
  const { req, res, webResponse } = getWrappedStreams(request, ctx);

  if (matchedPath) {
    req.headers['x-matched-path'] = matchedPath;
    res.setHeader('x-matched-path', matchedPath);
  }

  ctx.waitUntil(
    Promise.resolve(
      requestHandler(new NodeNextRequest(req), new NodeNextResponse(res)),
    ),
  );

  return await webResponse();
}

function getWrappedStreams(request: Request, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const req = (
    request.body ? Readable.fromWeb(request.body as any) : Readable.from([])
  ) as IncomingMessage;
  req.httpVersion = '1.0';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 0;
  req.url = url.href.slice(url.origin.length);
  req.headers = Object.fromEntries([...request.headers]);
  req.method = request.method;
  Object.defineProperty(req, 'headersDistinct', {
    get() {
      const headers: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) continue;
        headers[key] = Array.isArray(value) ? value : [value];
      }
      return headers;
    },
  });

  const { readable, writable } = new IdentityTransformStream();
  const resBodyWriter = writable.getWriter();

  const res = new MockedResponse({
    resWriter: (chunk) => {
      resBodyWriter
        .write(typeof chunk === 'string' ? textEncoder.encode(chunk) : chunk)
        .catch((err) => {
          if (
            err.message.includes('WritableStream has been closed') ||
            err.message.includes('Network connection lost')
          ) {
            // safe to ignore
            return;
          }
          console.error('Error in resBodyWriter.write');
          console.error(err);
        });
      return true;
    },
  });

  // It's implemented as a no-op, but really it should mark the headers as done
  res.flushHeaders = () => (res as any).headPromiseResolve();

  // Only allow statusCode to be modified if not sent
  let { statusCode } = res;
  Object.defineProperty(res, 'statusCode', {
    get: function () {
      return statusCode;
    },
    set: function (val) {
      if (this.finished || this.headersSent) {
        return;
      }
      statusCode = val;
    },
  });

  // Make sure the writer is eventually closed
  ctx.waitUntil(
    (res as any).hasStreamed.finally(() =>
      resBodyWriter.close().catch(() => {}),
    ),
  );

  return {
    res,
    req,
    webResponse: async () => {
      await res.headPromise;
      // TODO: remove this once streaming with compression is working nicely
      res.setHeader('content-encoding', 'identity');
      return new Response(
        NON_BODY_RESPONSES.has(res.statusCode) ? null : readable,
        {
          status: res.statusCode,
          headers: (res as any).headers,
        },
      );
    },
  };
}
