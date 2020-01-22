'use strict';

/*
	(import "wasi_unstable" "path_create_directory" (func $path_create_directory (type $t9)))
	(import "wasi_unstable" "path_rename" (func $path_rename (type $t11)))
	(import "wasi_unstable" "path_remove_directory" (func $path_remove_directory (type $t9)))
	(import "wasi_unstable" "fd_readdir" (func $fd_readdir (type $t12)))
	(import "wasi_unstable" "path_readlink" (func $path_readlink (type $t11)))
	(import "wasi_unstable" "path_filestat_get" (func $path_filestat_get (type $t13)))
*/

const fs = require('fs');
const path = require('path');

const std = ctor => ({
  size: ctor.BYTES_PER_ELEMENT,
  get(buf, ptr) {
    return new ctor(buf, ptr, 1);
  },
  set(buf, ptr, value) {
    new ctor(buf, ptr, 1)[0] = value;
  }
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const string = {
  get(buf, ptr, len) {
    return textDecoder.decode(new Uint8Array(buf, ptr, len));
  },
  set(buf, ptr, value, len) {
    let { read } = textEncoder.encodeInto(value, new Uint8Array(buf, ptr, len));
    if (read < value.length) {
      throw new Error(`Insufficient space.`);
    }
  }
};

function struct(desc) {
  let Ctor = class {
    constructor(buf, ptr) {
      this._buf = buf;
      this._ptr = ptr;
    }
  };
  let offset = 0;
  for (let name in desc) {
    let type = desc[name];
    let align = type.size;
    let mismatch = offset % align;
    if (mismatch) {
      offset += align - mismatch;
    }
    const fieldOffset = offset;
    Object.defineProperty(Ctor.prototype, name, {
      get() {
        return type.get(this._buf, this._ptr + fieldOffset);
      },
      set(value) {
        type.set(this._buf, this._ptr + fieldOffset, value);
      }
    });
    offset += type.size;
  }
  return {
    size: offset,
    get(buf, ptr) {
      return new Ctor(buf, ptr);
    }
  };
}

function enumer(desc) {
  return {
    size: desc.base.size,
    get(buf, ptr) {
      let id = desc.base.get(buf, ptr);
      let name = desc.variants[id];
      if (name === undefined) {
        throw new TypeError(`Invalid ID ${id}.`);
      }
      return name;
    },
    set(buf, ptr, value) {
      let id = desc.variants.indexOf(value);
      if (id === -1) {
        throw new TypeError(`Invalid variant ${value}.`);
      }
      desc.base.set(buf, ptr, id);
    }
  };
}

const int8_t = std(Int8Array);
const uint8_t = std(Uint8Array);
const int16_t = std(Int16Array);
const uint16_t = std(Uint16Array);
const int32_t = std(Int32Array);
const uint32_t = std(Uint32Array);
const int64_t = std(BigInt64Array);
const uint64_t = std(BigUint64Array);

const size_t = uint32_t;

const preopentype_t = enumer({
  base: int8_t,
  variants: ['dir']
});

const prestat_t = struct({
  type: preopentype_t,
  nameLen: size_t
});

const fd_t = uint32_t;

const iovec_t = struct({
  bufPtr: uint32_t,
  bufLen: size_t
});

const filetype_t = enumer({
  base: uint8_t,
  variants: [
    'unknown',
    'blockDevice',
    'charDevice',
    'directory',
    'regularFile',
    'socketDgram',
    'socketStream',
    'symbolicLink'
  ]
});

const fdflags_t = uint16_t;

const rights_t = uint64_t;

const fdstat_t = struct({
  filetype: filetype_t,
  flags: fdflags_t,
  rightsBase: rights_t,
  rightsInheriting: rights_t
});

const PREOPEN = '/sandbox';

const E = {
  SUCCESS: 0,
  BADF: 8
};

const PREOPEN_FD = 3;

let nextFd = PREOPEN_FD;

let openFiles = new Map([
  [0, { fd: 0 }],
  [1, { fd: 1 }],
  [2, { fd: 2 }]
]);

function open(path) {
  openFiles.set(nextFd, {
    path,
    fd: fs.openSync(path)
  });
  return nextFd++;
}

open('.');

module.exports = ({ memory, env, args }) => {
  let envOffsets = [];
  let envBuf = '';

  for (let key in env) {
    envOffsets.push(envBuf.length);
    envBuf += `${key}=${env[key]}\0`;
  }

  let argOffsets = [];
  let argBuf = '';

  for (let arg of args) {
    argOffsets.push(argBuf.length);
    argBuf += `${arg}\0`;
  }

  return {
    fd_prestat_get(fd, prestatPtr) {
      if (fd !== PREOPEN_FD) {
        return E.BADF;
      }
      let prestat = prestat_t.get(memory.buffer, prestatPtr);
      prestat.type = 'dir';
      prestat.nameLen = PREOPEN.length;
    },
    fd_prestat_dir_name(fd, pathPtr, pathLen) {
      if (fd != PREOPEN_FD) {
        return E.BADF;
      }
      string.set(memory.buffer, pathPtr, PREOPEN, pathLen);
    },
    environ_sizes_get(countPtr, sizePtr) {
      size_t.set(memory.buffer, countPtr, envOffsets.length);
      size_t.set(memory.buffer, sizePtr, envBuf.length);
    },
    environ_get(environPtr, environBufPtr) {
      new Uint32Array(memory.buffer, environPtr, envOffsets.length).set(
        envOffsets.map(offset => environBufPtr + offset)
      );
      string.set(memory.buffer, environBufPtr, envBuf);
    },
    args_sizes_get(argcPtr, argvBufSizePtr) {
      size_t.set(memory.buffer, argcPtr, argOffsets.length);
      size_t.set(memory.buffer, argvBufSizePtr, argBuf.length);
    },
    args_get(argvPtr, argvBufPtr) {
      new Uint32Array(memory.buffer, argvPtr, argOffsets.length).set(
        argOffsets.map(offset => argvBufPtr + offset)
      );
      string.set(memory.buffer, argvBufPtr, argBuf);
    },
    proc_exit(code) {
      process.exit(code);
    },
    random_get(bufPtr, bufLen) {
      require('crypto').randomFillSync(
        new Uint8Array(memory.buffer, bufPtr, bufLen)
      );
    },
    path_open(
      dirFd,
      dirFlags,
      pathPtr,
      pathLen,
      oFlags,
      fsRightsBase,
      fsRightsInheriting,
      fsFlags,
      fdPtr
    ) {
      let fullPath = path.resolve(
        openFiles.get(dirFd).path,
        string.get(memory.buffer, pathPtr, pathLen)
      );
      fd_t.set(memory.buffer, fdPtr, open(fullPath));
    },
    fd_close(fd) {
      openFiles.delete(fd);
    },
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      fd = openFiles.get(fd).fd;
      let nread = 0;
      for (let i = 0; i < iovsLen; i++) {
        let iovec = iovec_t.get(memory.buffer, iovsPtr);
        let read = fs.readSync(
          fd,
          new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen)
        );
        nread += read;
        if (read < iovec.bufLen) {
          break;
        }
        iovsPtr += iovec_t.size;
      }
      size_t.set(memory.buffer, nreadPtr, nread);
    },
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      fd = openFiles.get(fd).fd;
      let nwritten = 0;
      for (let i = 0; i < iovsLen; i++) {
        let iovec = iovec_t.get(memory.buffer, iovsPtr);
        let written = fs.writeSync(
          fd,
          new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen)
        );
        nwritten += written;
        if (written < iovec.bufLen) {
          break;
        }
        iovsPtr += iovec_t.size;
      }
      size_t.set(memory.buffer, nwrittenPtr, nwritten);
    },
    fd_fdstat_get(fd, fdstatPtr) {
      let fdstat = fdstat_t.get(memory.buffer, fdstatPtr);
      fdstat.filetype = fs.fstatSync(openFiles.get(fd).fd).isDirectory()
        ? 'directory'
        : 'regularFile';
      fdstat.flags = 0;
      fdstat.rightsBase = BigInt(-1);
      fdstat.rightsInheriting = BigInt(-1);
    },
    path_create_directory() {},
    path_rename() {},
    path_remove_directory() {},
    fd_readdir() {},
    path_readlink() {},
    path_filestat_get() {}
  };
};
