import { NodeRequestHandler } from 'next/dist/server/next-server';

export const NON_BODY_RESPONSES = new Set([101, 204, 205, 304]);

const prerenderManifest = (globalThis as any).PRERENDER_MANIFEST as {
  routes: Record<
    string,
    {
      experimentalPPR?: boolean;
      initialRevalidateSeconds: boolean | number;
      dataRoute: string;
      initialHeaders: Record<string, string>;
    }
  >;
};

export async function isrPut(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cacheKey: string,
  cacheResponse: Response,
  dataRoute: string,
  requestHandler: NodeRequestHandler,
  getNextResponse: (
    request: Request,
    ctx: ExecutionContext,
    matchedPath: string,
    requestHandler: NodeRequestHandler,
  ) => Promise<Response>,
) {
  const url = new URL(request.url);
  const isRscRequest =
    !!request.headers.get('rsc') || url.pathname.endsWith('.rsc');
  const htmlPath = url.pathname.endsWith('.rsc')
    ? url.pathname.slice(0, -4)
    : url.pathname;
  const rscPath = dataRoute;

  const requests = [htmlPath, rscPath].map(
    (path) =>
      new Request(new URL(path, request.url), {
        method: request.method,
        headers: {
          ...Object.fromEntries([...request.headers]),
          // TODO: Fix this up
          'x-now-route-matches': isRscRequest
            ? `1=${encodeURIComponent(htmlPath.slice(1))}&rsc=1`
            : '',
        },
        body: request.clone().body,
      }),
  );

  const responses = requests.map(async (request) => {
    const response = await getNextResponse(
      request,
      ctx,
      cacheResponse.headers.get('x-matched-path') ?? '',
      requestHandler,
    );
    const thisCacheKey = request.url.endsWith('.rsc')
      ? cacheKey.replace(/\.html$/, '.rsc')
      : cacheKey.replace(/\.rsc$/, '.html');
    return env.CACHE.put(
      thisCacheKey,
      JSON.stringify({
        status: response.status,
        headers: {
          date: new Date().toUTCString(),
          ...Object.fromEntries([...response.headers]),
        },
        body: response.headers.get('content-type')?.startsWith('text/')
          ? await response.text()
          : Buffer.from(await response.arrayBuffer()).toString('base64'),
      }),
    );
  });

  return Promise.all(responses);
}

export async function ssgPut(
  env: Env,
  cacheKey: string,
  cacheResponse: Response,
) {
  const resClone = cacheResponse.clone();
  return env.CACHE.put(
    cacheKey,
    JSON.stringify({
      status: cacheResponse.status,
      headers: Object.fromEntries([...cacheResponse.headers]),
      body: cacheResponse.headers.get('content-type')?.startsWith('text/')
        ? await resClone.text()
        : Buffer.from(await resClone.arrayBuffer()).toString('base64'),
    }),
  );
}

export async function createPprResponse(
  request: Request,
  ctx: ExecutionContext,
  cacheKey: string,
  cacheResponse: Response,
  requestHandler: NodeRequestHandler,
  getNextResponse: (
    request: Request,
    ctx: ExecutionContext,
    matchedPath: string,
    requestHandler: NodeRequestHandler,
  ) => Promise<Response>,
) {
  const url = new URL(request.url);
  const metaKey = cacheKey
    .slice(cacheKey.indexOf(':') + 1)
    .replace(/\.(prefetch\.rsc|rsc|html)$/, '.meta');
  const { postponed } = (globalThis as any).PRERENDER_META[metaKey];

  const postponePath =
    '/_next/postponed/resume' +
    (url.pathname === '/' ? '/index' : url.pathname);
  const postponeRequest = new Request(new URL(postponePath, request.url), {
    method: 'POST',
    headers: request.headers,
    body: postponed,
  });
  const postponeResponsePromise = getNextResponse(
    postponeRequest,
    ctx,
    postponePath,
    requestHandler,
  );

  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();

  ctx.waitUntil(
    (async () => {
      if (cacheResponse.body != null) {
        // @ts-expect-error
        for await (const chunk of cacheResponse.body) {
          writer.write(chunk);
        }
      }
      const postponeResponse = await postponeResponsePromise;
      if (postponeResponse.body != null) {
        // @ts-expect-error
        for await (const chunk of postponeResponse.body) {
          writer.write(chunk);
        }
      }
      writer.close();
    })(),
  );

  const headers = new Headers(cacheResponse.headers);
  headers.delete('etag');

  // TODO: hack for wrangler local dev streaming
  headers.set('content-encoding', 'identity');

  return new Response(readable, {
    status: cacheResponse.status,
    headers,
  });
}

export async function getCachedResponse(
  request: Request,
  env: Env,
  routeManifest: {
    staticRoutes: { page: string; regex: string }[];
    dynamicRoutes: { page: string; regex: string }[];
    rsc: { contentTypeHeader: string; varyHeader: string };
  },
) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return {};
  }

  const url = new URL(request.url);

  const isRscRequest =
    !!request.headers.get('rsc') || url.pathname.endsWith('.rsc');

  const prerenderPath = url.pathname.endsWith('.rsc')
    ? url.pathname.slice(0, -4)
    : url.pathname;
  const prerender = prerenderManifest.routes[prerenderPath];
  if (prerender == null) {
    return {};
  }
  let { initialHeaders, dataRoute } = prerender;
  initialHeaders ??= {};

  const matchedPath = isRscRequest ? dataRoute : prerenderPath;

  const assetPrefix =
    '/app' + (prerenderPath === '/' ? '/index' : prerenderPath);

  const meta = (globalThis as any).PRERENDER_META[assetPrefix + '.meta'];
  let status = 0;
  if (meta) {
    const { status: metaStatus, headers } = meta;
    status = metaStatus;
    initialHeaders = { ...initialHeaders, ...headers };
  }

  if (isRscRequest) {
    initialHeaders['content-type'] = routeManifest.rsc.contentTypeHeader;
  }

  // TODO: deal with JSON?
  // TODO: deal with .prefetch.rsc?
  const assetSuffix = isRscRequest
    ? '.rsc' // (meta?.postponed ? '.prefetch.rsc' : '.rsc')
    : !initialHeaders['content-type'] ||
        initialHeaders['content-type'].startsWith('text/html')
      ? '.html'
      : '.body';

  const cacheKey =
    (globalThis as any).BUILD_ID + ':' + assetPrefix + assetSuffix;
  const entry = await env.CACHE.get<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>(cacheKey, { type: 'json' });
  if (entry) {
    let { status = 200, headers = {} } = entry;
    const body = headers['content-type']?.startsWith('text/')
      ? entry.body
      : Buffer.from(entry.body, 'base64');
    if (request.headers.get('if-none-match') === headers.etag) {
      status = 304;
    }
    if (
      !headers['cache-control'] ||
      headers['cache-control'].includes('stale-while-revalidate')
    ) {
      headers['cache-control'] = 'public, max-age=0, must-revalidate';
    }
    const cachedAt = new Date(headers.date ?? Date.now());
    const age = Math.floor((Date.now() - +cachedAt) / 1000);
    return {
      cacheKey,
      prerender,
      cacheResponse: new Response(
        NON_BODY_RESPONSES.has(status) ? null : body,
        {
          status,
          headers: {
            ...headers,
            'x-matched-path': matchedPath,
            vary: routeManifest.rsc.varyHeader,
            age: age.toString(),
            date: cachedAt.toUTCString(),
            'x-nextjs-cache':
              typeof prerender.initialRevalidateSeconds === 'number' &&
              age > prerender.initialRevalidateSeconds
                ? 'STALE'
                : 'HIT',
          },
        },
      ),
    };
  }

  const assetPath = '/cdn-cgi' + assetPrefix + assetSuffix;

  const res = await env.ASSETS.fetch('http://assets' + assetPath, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  // Can also return 304 statuses
  if (res.status >= 400) {
    console.log(
      'Could not find!',
      new URL(assetPath, request.url).toString(),
      res.status,
      Object.fromEntries([...res.headers]),
    );
    return { cacheKey, prerender };
  }

  return {
    cacheKey,
    prerender,
    cacheResponse: new Response(res.body, {
      status: res.status, // TODO: Figure out what to do here for 304s, etc
      headers: {
        ...Object.fromEntries([...res.headers]),
        ...initialHeaders,
        'x-matched-path': matchedPath,
        vary: routeManifest.rsc.varyHeader,
        age: '0',
        date: new Date().toUTCString(),
        'x-nextjs-cache': 'PRERENDER',
      },
    }),
  };
}

export async function internalFetch(
  cache: KVNamespace,
  input: RequestInfo | URL,
  init: RequestInit,
) {
  const { fetchType, fetchUrl } = init.next as any; // cache-get, cache-set, or nothing (if revalidate)
  const headers = new Headers(init.headers);

  // get: GET /v1/suspense-cache/<key>
  // set: POST /v1/suspense-cache/<key>
  // revalidate: POST /v1/suspense-cache/revalidate?tags=...

  if (fetchType === 'cache-set') {
    const key = input.toString().split('/').pop() ?? '';

    await cache.put(key, init.body as string, {
      metadata: {
        cachedAt: Date.now(),
        fetchUrl,
        tags: headers.get('x-vercel-cache-tags'),
        revalidate: headers.get('x-vercel-revalidate'),
      },
    });
    return new Response(null, { status: 200 });
  } else if (fetchType === 'cache-get') {
    const tags = (headers.get('x-vercel-cache-tags') ?? '').split(',');
    const tagGets = Promise.all(
      tags.map(async (tag) =>
        cache.get<{ revalidatedAt: number }>(`tags:${tag}`, { type: 'json' }),
      ),
    );
    const key = input.toString().split('/').pop() ?? '';

    const entry = await cache.getWithMetadata(key);

    if (!entry.value) {
      return new Response(null, { status: 404 });
    }

    const { cachedAt, revalidate } = entry.metadata as Record<string, any>;

    const age = Math.floor((Date.now() - +cachedAt) / 1000);

    // TODO: need better revalidate logic here?
    const tagResults = await tagGets;
    const anyTagsStale = tagResults.some(
      (tag) => (tag?.revalidatedAt || -Infinity) > cachedAt,
    );
    if (anyTagsStale) {
      return new Response(null, { status: 404 });
    }

    return new Response(entry.value, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        age: age.toString(),
        date: new Date(+cachedAt).toUTCString(),
        ['x-vercel-cache-state']:
          age > (+revalidate || Infinity)
            ? 'stale'
            : // : +revalidate > 0
              //   ? 'stale-while-revalidate'
              'fresh',
      },
    });
  } else if (typeof input === 'string') {
    const { pathname, searchParams } = new URL(input);

    if (pathname.endsWith('/revalidate')) {
      const tags = (searchParams.get('tags') ?? '').split(',');

      await Promise.all(
        tags.map(async (tag) =>
          cache.put(
            `tags:${tag}`,
            JSON.stringify({ revalidatedAt: Date.now() }),
          ),
        ),
      );

      return new Response(null, { status: 200 });
    }
  }
  console.error('unknown cache call');

  // TODO: Implement revalidate
  return new Response(null, { status: 200 });
}
