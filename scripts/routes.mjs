const headers = [];

if (routesManifest.headers) {
  headers.push(...convertHeaders(routesManifest.headers));
}
headers.forEach((r, i) => updateRouteSrc(r, i, routesManifest.headers || []));

const routes = [
  // Not including private routes
  // '_next/__private/trace'
  // _next/__private/stats.json
  // ...privateOutputs.routes,

  ...headers,

  ...redirects,

  ...beforeFilesRewrites,

  // Make sure to 404 for the /404 path itself
  {
    src: path.posix.join('/', entryDirectory, '404/?'),
    status: 404,
    continue: true,
  },

  // Next.js pages, `static/` folder, reserved assets, and `public/`
  // folder
  { handle: 'filesystem' },

  // ensure the basePath prefixed _next/image is rewritten to the root
  // _next/image path
  ...(routesManifest?.basePath
    ? [
        {
          src: path.posix.join('/', entryDirectory, '_next/image/?'),
          dest: '/_next/image',
          check: true,
        },
      ]
    : []),

  // No-op _next/data rewrite to trigger handle: 'rewrites' and then 404
  // if no match to prevent rewriting _next/data unexpectedly
  {
    src: path.posix.join('/', entryDirectory, '_next/data/(.*)'),
    dest: path.posix.join('/', entryDirectory, '_next/data/$1'),
    check: true,
  },
  {
    src: path.posix.join('/', entryDirectory, '_next/data/(.*)'),
    status: 404,
  },

  // These need to come before handle: miss or else they are grouped
  // with that routing section
  ...afterFilesRewrites,

  // make sure 404 page is used when a directory is matched without
  // an index page
  { handle: 'resource' },

  ...fallbackRewrites,

  { src: path.posix.join('/', entryDirectory, '.*'), status: 404 },

  // We need to make sure to 404 for /_next after handle: miss since
  // handle: miss is called before rewrites and to prevent rewriting
  // /_next
  { handle: 'miss' },
  {
    src: path.posix.join(
      '/',
      entryDirectory,
      '_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media)/.+',
    ),
    status: 404,
    check: true,
    dest: '$0',
  },

  // Dynamic routes
  // TODO: do we want to do this?: ...dynamicRoutes,
  // (if so make sure to add any dynamic routes after handle: 'rewrite' )

  // routes to call after a file has been matched
  { handle: 'hit' },
  // Before we handle static files we need to set proper caching headers
  {
    // This ensures we only match known emitted-by-Next.js files and not
    // user-emitted files which may be missing a hash in their filename.
    src: path.posix.join(
      '/',
      entryDirectory,
      `_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media|${escapedBuildId})/.+`,
    ),
    // Next.js assets contain a hash or entropy in their filenames, so they
    // are guaranteed to be unique and cacheable indefinitely.
    headers: {
      'cache-control': `public,max-age=${MAX_AGE_ONE_YEAR},immutable`,
    },
    continue: true,
    important: true,
  },

  // error handling
  ...(output[path.posix.join('./', entryDirectory, '404')] ||
  output[path.posix.join('./', entryDirectory, '404/index')]
    ? [
        { handle: 'error' },

        {
          status: 404,
          src: path.posix.join(entryDirectory, '.*'),
          dest: path.posix.join('/', entryDirectory, '404'),
        },
      ]
    : []),
];

console.log(routes);
