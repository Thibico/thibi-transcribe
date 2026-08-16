// @thibi/storage — the ObjectStore port and its adapters.
//
// One interface, three adapters, one contract suite run against all of them. That is what
// makes `STORAGE_DRIVER=fs` a supported configuration rather than a degraded one, and what
// lets every test above this layer run without a container.

export {
  NotSupportedError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  StorageError,
  type HeadResult,
  type ObjectStore,
  type PutOpts,
  type PutResult,
  type TempDir,
  type TempFile,
} from './types.js';

export {
  assertSafeKey,
  assetKey,
  chunkKey,
  chunkResultKey,
  derivativeKey,
  diarizationResultKey,
  extensionOf,
  rawResponseKey,
  runChunksPrefix,
  runPrefix,
} from './keys.js';

export { MemoryObjectStore } from './memory.js';
export { FsObjectStore } from './fs.js';
export { S3ObjectStore, type S3ObjectStoreOptions } from './s3.js';
export {
  createTempDirPort,
  fromTempFile,
  toTempFile,
  type TempDirPort,
} from './tempfile.js';
