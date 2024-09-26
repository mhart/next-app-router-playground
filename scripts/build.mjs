import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

const ENTRYPOINT = import.meta.dirname + '/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname + '/..');

const BASE_DIR = path.resolve(REPO_ROOT + '/.next');
const APP_BASE_DIR = path.resolve(BASE_DIR + '/standalone');
const NEXT_DIR = path.resolve(APP_BASE_DIR + '/.next');
const NEXT_SERVER_DIR = path.resolve(NEXT_DIR + '/server');

const OUTFILE = APP_BASE_DIR + '/worker.mjs';

execSync(`mkdir -p ${BASE_DIR}/assets/_next`);
execSync(`cp -R ${BASE_DIR}/static ${BASE_DIR}/assets/_next/`);
if (existsSync(`${REPO_ROOT}/public`)) {
  execSync(`cp -R ${REPO_ROOT}/public/* ${BASE_DIR}/assets/`);
}
execSync(`mkdir -p ${BASE_DIR}/assets/cdn-cgi/app`);

const nextConfigStr = readFileSync(APP_BASE_DIR + '/server.js', 'utf8').match(
  /const nextConfig = ({.+?})\n/,
)[1];

const metaEntries = globSync(
  globSync(`${NEXT_SERVER_DIR}/app/**/*.meta`),
).reduce((acc, file) => {
  acc[file.replace(NEXT_SERVER_DIR, '')] = JSON.parse(
    readFileSync(file, 'utf-8'),
  );
  return acc;
}, Object.create(null));

const hiddenAssetFiles = [];

const prerenderFileGlobs = [
  `${NEXT_SERVER_DIR}/app/**/*.html`,
  `${NEXT_SERVER_DIR}/app/**/*.body`,
  `${NEXT_SERVER_DIR}/app/**/*.rsc`,
];
for (const prerenderFileGlob of prerenderFileGlobs) {
  for (const prerenderFile of globSync(prerenderFileGlob)) {
    hiddenAssetFiles.push(prerenderFile);
  }
}

const pagesManifestFile = NEXT_SERVER_DIR + '/pages-manifest.json';
const appPathsManifestFile = NEXT_SERVER_DIR + '/app-paths-manifest.json';

const pagesManifestFiles = existsSync(pagesManifestFile)
  ? Object.values(JSON.parse(readFileSync(pagesManifestFile, 'utf-8'))).map(
      (file) => '.next/server/' + file,
    )
  : [];
const appPathsManifestFiles = existsSync(appPathsManifestFile)
  ? Object.values(JSON.parse(readFileSync(appPathsManifestFile, 'utf-8'))).map(
      (file) => '.next/server/' + file,
    )
  : [];
const allManifestFiles = pagesManifestFiles.concat(appPathsManifestFiles);

const htmlPages = allManifestFiles.filter((file) => file.endsWith('.html'));
const pageModules = allManifestFiles.filter((file) => file.endsWith('.js'));

for (const htmlPage of htmlPages) {
  hiddenAssetFiles.push(APP_BASE_DIR + '/' + htmlPage);
}

for (const hiddenAssetFile of hiddenAssetFiles) {
  // TODO: do this using Node.js methods
  const dest = `${BASE_DIR}/assets/cdn-cgi/${hiddenAssetFile
    .replace(NEXT_SERVER_DIR, '')
    .slice(1)}`;
  execSync(`mkdir -p ${path.dirname(dest)}`);
  execSync(`cp ${hiddenAssetFile} ${dest}`);
}

const buildId = readFileSync(NEXT_DIR + '/BUILD_ID', 'utf-8').trim();

const routesManifest = readFileSync(
  NEXT_DIR + '/routes-manifest.json',
  'utf-8',
).trim();
const prerenderManifest = readFileSync(
  NEXT_DIR + '/prerender-manifest.json',
  'utf-8',
).trim();

let replaceRelativePlugin = {
  name: 'replaceRelative',
  setup(build) {
    // Can't use custom require hook
    build.onResolve({ filter: /^\.\/require-hook$/ }, (args) => ({
      path: path.join(import.meta.dirname, './shim-empty.mjs'),
    }));
    // No need for edge-runtime sandbox
    build.onResolve({ filter: /\.\/web\/sandbox$/ }, (args) => ({
      path: path.join(import.meta.dirname, './shim-empty.mjs'),
    }));
    // No need for fs
    build.onResolve({ filter: /\.\/lib\/node-fs-methods$/ }, (args) => ({
      path: path.join(import.meta.dirname, './shim-empty.mjs'),
    }));
    // No need for filesystem cache
    build.onResolve({ filter: /\.\/file-system-cache$/ }, (args) => ({
      path: path.join(import.meta.dirname, './shim-empty.mjs'),
    }));
    // No need for supporting previews and jsonwebtoken
    build.onResolve(
      { filter: /\.\/api-utils\/node\/try-get-preview-data$/ },
      (args) => ({
        path: path.join(import.meta.dirname, './shim-try-get-preview-data.mjs'),
      }),
    );
  },
};

const result = await esbuild.build({
  entryPoints: [ENTRYPOINT],
  bundle: true,
  outfile: OUTFILE,
  alias: {
    'next/dist/experimental/testmode/server': path.join(
      import.meta.dirname,
      './shim-empty.mjs',
    ),
    'next/dist/compiled/ws': path.join(import.meta.dirname, './shim-empty.mjs'),
    'next/dist/compiled/node-html-parser': path.join(
      import.meta.dirname,
      './shim-node-html-parser.mjs',
    ),
    '@next/env': path.join(import.meta.dirname, './shim-env.mjs'),
    '@opentelemetry/api': path.join(import.meta.dirname, './shim-throw.mjs'),
    critters: path.join(import.meta.dirname, './shim-throw.mjs'),
    'next/dist/compiled/@ampproject/toolbox-optimizer': path.join(
      import.meta.dirname,
      './shim-throw.mjs',
    ),
    'next/dist/compiled/jsonwebtoken': path.join(
      import.meta.dirname,
      './shim-throw.mjs',
    ),
  },
  plugins: [replaceRelativePlugin],
  format: 'esm',
  target: 'esnext',
  minify: false,
  define: {
    'process.env.NEXT_RUNTIME': '"nodejs"',
    __dirname: '""',
    'globalThis.__NEXT_HTTP_AGENT': '{}',
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_MINIMAL': 'true',
    'process.env.NEXT_PRIVATE_MINIMAL_MODE': 'true',
    'process.env.TURBOPACK': 'false',
    'process.env.__NEXT_EXPERIMENTAL_REACT': 'true',
    __non_webpack_require__: 'require',
    'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG':
      JSON.stringify(nextConfigStr),
    'process.env.NEXT_PRIVATE_DEBUG_CACHE': 'true',
    'process.env.SUSPENSE_CACHE_URL': '"suspense-cache"',
  },
  platform: 'node',
  metafile: true,
  banner: {
    js: `
globalThis.__dirname ??= "";

function patchInit(init) {
  return init ? {
    ...init,
    cache: undefined,
    body: init.body instanceof Readable ? Readable.toWeb(init.body) : init.body
  } : init;
}

let isPatchedAlready = globalThis.fetch.__nextPatched;
const curFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (init?.next?.internal) {
    return globalThis.INTERNAL_FETCH?.(input, init);
  }
  return curFetch(input, patchInit(init));
};
globalThis.fetch.__nextPatched = isPatchedAlready;
fetch = globalThis.fetch;

const CustomRequest = class extends globalThis.Request {
  constructor(input, init) {
    super(input, patchInit(init));
  }
};
globalThis.Request = CustomRequest;
Request = globalThis.Request;

globalThis.PRERENDER_META = ${JSON.stringify(metaEntries)};
globalThis.BUILD_ID = ${JSON.stringify(buildId)};
globalThis.ROUTES_MANIFEST = ${routesManifest};
globalThis.PRERENDER_MANIFEST = ${prerenderManifest};
    `,
  },
});

let contents = readFileSync(OUTFILE, 'utf-8');

contents = contents
  .replace(/__require\d?\(/g, 'require(')
  .replace(/__require\d?\./g, 'require.');

contents = contents.replace(
  'getBuildId() {',
  `getBuildId() {
    return ${JSON.stringify(buildId)};
  `,
);

const manifestJsons = globSync(NEXT_DIR + '/**/*-manifest.json').map((file) =>
  file.replace(APP_BASE_DIR + '/', ''),
);

contents = contents.replace(
  /function loadManifest\((.+?), .+?\) {/,
  `$&
  ${manifestJsons
    .map(
      (manifestJson) => `
        if ($1.endsWith("${manifestJson}")) {
          return ${readFileSync(APP_BASE_DIR + '/' + manifestJson, 'utf-8')};
        }
      `,
    )
    .join('\n')}
  throw new Error("Unknown loadManifest: " + $1);
  `,
);

contents = contents.replace(
  /const pagePath = getPagePath\(.+?\);/,
  `$&
  ${htmlPages
    .map(
      (htmlPage) => `
        if (pagePath.endsWith("${htmlPage}")) {
          return globalThis.ASSET_READ?.("${htmlPage.replace(/^\.next\/server\//, '')}");
        }
      `,
    )
    .join('\n')}
  ${pageModules
    .map(
      (module) => `
        if (pagePath.endsWith("${module}")) {
          return require("${APP_BASE_DIR}/${module}");
        }
      `,
    )
    .join('\n')}
  throw new Error("Unknown pagePath: " + pagePath);
  `,
);

contents = contents.replace(
  'require(this.middlewareManifestPath)',
  `require("${NEXT_SERVER_DIR}/middleware-manifest.json")`,
);

const HAS_APP_DIR = existsSync(NEXT_SERVER_DIR + '/app');
const HAS_PAGES_DIR = existsSync(NEXT_SERVER_DIR + '/pages');

contents = contents.replace(
  'function findDir(dir, name) {',
  `function findDir(dir, name) {
    if (dir.endsWith(".next/server")) {
      if (name === "app") return ${HAS_APP_DIR};
      if (name === "pages") return ${HAS_PAGES_DIR};
    }
    throw new Error("Unknown findDir call: " + dir + " " + name);
`,
);

contents = contents.replace(
  'async function loadClientReferenceManifest(manifestPath, entryName) {',
  `async function loadClientReferenceManifest(manifestPath, entryName) {
    const context = await evalManifestWithRetries(manifestPath);
    return context.__RSC_MANIFEST[entryName];
`,
);

const manifestJss = globSync(
  NEXT_DIR + '/**/*_client-reference-manifest.js',
).map((file) => file.replace(APP_BASE_DIR + '/', ''));

contents = contents.replace(
  /function evalManifest\((.+?), .+?\) {/,
  `$&
  ${manifestJss
    .map(
      (manifestJs) => `
        if ($1.endsWith("${manifestJs}")) {
          require("${APP_BASE_DIR}/${manifestJs}");
          return {
            __RSC_MANIFEST: {
              "${manifestJs
                .replace('.next/server/app', '')
                .replace(
                  '_client-reference-manifest.js',
                  '',
                )}": globalThis.__RSC_MANIFEST["${manifestJs
                .replace('.next/server/app', '')
                .replace('_client-reference-manifest.js', '')}"],
            },
          };
        }
      `,
    )
    .join('\n')}
  throw new Error("Unknown evalManifest: " + $1);
  `,
);

contents = contents.replace(
  /var NodeModuleLoader = class {.+?async load\((.+?)\) {/s,
  `$&
  ${pageModules
    .map(
      (module) => `
        if ($1.endsWith("${module}")) {
          return require("${APP_BASE_DIR}/${module}");
        }
      `,
    )
    .join('\n')}
  throw new Error("Unknown NodeModuleLoader: " + $1);
  `,
);

// We don't have edge functions in front of this, so just 404
contents = contents.replace(
  /result = await this.renderHTML\(.+?\);/,
  'result = { metadata: { isNotFound: true } };',
);

contents = contents.replace(
  'this.instrumentation = await this.loadInstrumentationModule()',
  'this.instrumentation = null',
);

writeFileSync(OUTFILE, contents);

writeFileSync(
  import.meta.dirname + '/meta.json',
  JSON.stringify(result.metafile, null, 2),
);

const chunks = readdirSync(NEXT_SERVER_DIR + '/chunks')
  .filter((chunk) => /^\d+\.js$/.test(chunk))
  .map((chunk) => chunk.replace(/\.js$/, ''));
const webpackRuntimeFile = NEXT_SERVER_DIR + '/webpack-runtime.js';
writeFileSync(
  webpackRuntimeFile,
  readFileSync(webpackRuntimeFile, 'utf-8').replace(
    '__webpack_require__.f.require = (chunkId, promises) => {',
    `__webpack_require__.f.require = (chunkId, promises) => {
      if (installedChunks[chunkId]) return;
      ${chunks
        .map(
          (chunk) => `
        if (chunkId === ${chunk}) {
          installChunk(require("./chunks/${chunk}.js"));
          return;
        }
      `,
        )
        .join('\n')}
    `,
  ),
);

const kvAssetHandlerBase = existsSync(
  REPO_ROOT + '/node_modules/.pnpm/node_modules/@cloudflare/kv-asset-handler',
)
  ? REPO_ROOT + '/node_modules/.pnpm/node_modules/@cloudflare/kv-asset-handler'
  : REPO_ROOT + '/node_modules/@cloudflare/kv-asset-handler';

const cloudflareAssetsFile = kvAssetHandlerBase + '/dist/index.js';
writeFileSync(
  cloudflareAssetsFile,
  readFileSync(cloudflareAssetsFile, 'utf-8').replace(
    'const mime = __importStar(require("mime"));',
    'let mime = __importStar(require("mime")); mime = mime.default ?? mime;',
  ),
);

const unenvBase = existsSync(
  REPO_ROOT + '/node_modules/.pnpm/node_modules/unenv',
)
  ? REPO_ROOT + '/node_modules/.pnpm/node_modules/unenv'
  : REPO_ROOT + '/node_modules/unenv';

const unenvProcessFiles = [
  unenvBase + '/runtime/node/process/$cloudflare.cjs',
  unenvBase + '/runtime/node/process/$cloudflare.mjs',
];
for (const unenvFile of unenvProcessFiles) {
  writeFileSync(
    unenvFile,
    readFileSync(unenvFile, 'utf-8').replace(
      'const unpatchedGlobalThisProcess = globalThis["process"];',
      'const processKey = "process"; const unpatchedGlobalThisProcess = globalThis[processKey];',
    ),
  );
}

const unenvRequestFiles = [
  unenvBase + '/runtime/node/http/internal/request.cjs',
  unenvBase + '/runtime/node/http/internal/request.mjs',
];
for (const unenvFile of unenvRequestFiles) {
  writeFileSync(
    unenvFile,
    readFileSync(unenvFile, 'utf-8').replace(
      /"\.\.\/\.\.\/stream\/internal\/readable\.[cm]js"/,
      '"node:stream"',
    ),
  );
}
