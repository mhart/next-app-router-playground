export const nodeFs = {
  existsSync,
  readFile,
  readFileSync,
  writeFile,
  mkdir,
  stat,
};

function existsSync(path) {
  console.log(
    'existsSync',
    path,
    new Error().stack.split('\n').slice(1).join('\n'),
  );
  return typeof globalThis.MY_FILE_CACHE[path] === 'string';
}

async function readFile(path, options) {
  console.log(
    'readFile',
    { path, options },
    // new Error().stack.split("\n").slice(1).join("\n"),
  );
  if (typeof globalThis.MY_FILE_CACHE[path] !== 'string') {
    throw new Error(path + 'does not exist');
  }
  return globalThis.MY_FILE_CACHE[path];
}

function readFileSync(path, options) {
  console.log(
    'readFileSync',
    { path, options },
    // new Error().stack.split("\n").slice(1).join("\n"),
  );
  if (typeof globalThis.MY_FILE_CACHE[path] !== 'string') {
    throw new Error(path + 'does not exist');
  }
  return globalThis.MY_FILE_CACHE[path];
}

async function writeFile(file, data) {
  console.log(
    'writeFile',
    { file, data },
    // new Error().stack.split("\n").slice(1).join("\n"),
  );
  globalThis.MY_FILE_CACHE[file] = data;
  return true;
}

async function mkdir(dir) {
  console.log(
    'mkdir',
    dir,
    //new Error().stack.split("\n").slice(1).join("\n"),
  );
}

async function stat(file) {
  console.log(
    'stat',
    file,
    // new Error().stack.split("\n").slice(1).join("\n"),
  );
  return { mtime: new Date(globalThis.MY_FILE_CACHE_MTIME) };
}
