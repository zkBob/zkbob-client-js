import { Privkey } from 'hdwallet-babyjub';
import { numberToHex, padLeft } from 'web3-utils';

import { NetworkType } from './network-type';
import { InternalError } from './errors';

import { TreeNode } from 'libzkbob-rs-wasm-web';

const util = require('ethereumjs-util');

// Key derivation which depend on network
export function deriveSpendingKey(mnemonic: string, networkType: NetworkType): Uint8Array {
  const path = NetworkType.privateDerivationPath(networkType);
  const sk = bigintToArrayLe(Privkey(mnemonic, path).k);

  return sk;
}

// Universal key derivation: the same SK will be derived for each network from a seed
export function deriveSpendingKeyZkBob(mnemonic: string): Uint8Array {
  return bigintToArrayLe(Privkey(mnemonic, "m/0'/0'").k);
}

const HEX_TABLE: string[] = [];
for (let n = 0; n <= 0xff; ++n) {
  const octet = n.toString(16).padStart(2, '0');
  HEX_TABLE.push(octet);
}

export function concatenateBuffers(buf1: Uint8Array, buf2: Uint8Array): Uint8Array {
  var res = new Uint8Array(buf1.byteLength + buf2.byteLength);
  res.set(buf1, 0);
  res.set(buf2, buf1.byteLength);

  return res;
}

export function bufToHex(buffer: Uint8Array): string {
  const octets = new Array(buffer.length);

  for (let i = 0; i < buffer.length; ++i)
    octets[i] = (HEX_TABLE[buffer[i]]);

  return octets.join('');
}

export function base64ToHex(data: string): string {
  const bytes = atob(data);
  const octets = new Array(bytes.length);

  for (let i = 0; i < bytes.length; ++i) {
    octets[i] = HEX_TABLE[bytes.charCodeAt(i)];
  }

  return octets.join('');
}

export function bigintToArrayLe(num: bigint): Uint8Array {
  const result = new Uint8Array(32);

  for (let i = 0; num > BigInt(0); ++i) {
    result[i] = Number(num % BigInt(256));
    num = num / BigInt(256);
  }

  return result;
}

export function truncateHexPrefix(data: string): string {
  if (data.startsWith('0x')) {
    data = data.slice(2);
  }

  return data;
}

export function addHexPrefix(data: string): string {
  if (data.startsWith('0x') == false) {
    data = `0x` + data;
  }

  return data;
}

// Convert input hex number to the bytes array
// extend (leading zero-bytes) or trim (trailing bytes)
// output buffer to the bytesCnt bytes (only when bytesCnt > 0)
export function hexToBuf(hex: string, bytesCnt: number = 0): Uint8Array {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }

  if (bytesCnt > 0) {
    const digitsNum = bytesCnt * 2;
    hex = hex.slice(-digitsNum).padStart(digitsNum, '0');
  }

  if (hex.length % 2 !== 0) {
    throw new InternalError('Invalid hex string');
  }

  const buffer = new Uint8Array(hex.length / 2);

  for (let i = 0; i < hex.length; i = i + 2) {
    buffer[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }

  return buffer;
}

export function forceDecimal(hexOrDec: string): string {
  if (hexOrDec.startsWith('0x')) {
    return BigInt(hexOrDec).toString(10);
  }

  return hexOrDec;
}

export function isEqualBuffers(buf1: Uint8Array, buf2: Uint8Array): boolean {
  if (buf1.length != buf2.length) {
    return false;
  }

  for (let i = 0; i < buf1.length; i++) {
    if(buf1[i] != buf2[i]) {
      return false;
    }
  }

  return true;
}

export class HexStringWriter {
  buf: string;

  constructor() {
    this.buf = '0x';
  }

  toString() {
    return this.buf;
  }

  writeHex(hex: string) {
    this.buf += hex;
  }

  writeBigInt(num: bigint, numBytes: number, le: boolean = false) {
    let hex = toTwosComplementHex(num, numBytes);
    if (le) {
      hex = hex.match(/../g)!.reverse().join('');
    }
    this.buf += hex;
  }

  writeBigIntArray(nums: bigint[], numBytes: number) {
    for (const num of nums) {
      this.writeBigInt(num, numBytes);
    }
  }

  writeNumber(num: number, numBytes: number) {
    this.buf += padLeft(numberToHex(num).slice(2), numBytes * 2);
  }
}

export class HexStringReader {
  data: string;
  curIndex: number;

  constructor(data: string) {
    if (data.slice(0, 2) == '0x') {
      data = data.slice(2);
    }

    this.data = data;
    this.curIndex = 0;
  }

  readHex(numBytes: number): string | null {
    const sliceEnd = this.curIndex + numBytes * 2;

    if (sliceEnd > this.data.length) {
      return null;
    }

    const res = this.data.slice(this.curIndex, sliceEnd);
    this.curIndex = sliceEnd;
    return res;
  }

  readNumber(numBytes: number, le: boolean = false): number | null {
    let hex = this.readHex(numBytes);
    if (!hex) return null;

    if (le) {
      hex = hex.match(/../g)!.reverse().join('');
    }
    return parseInt(hex, 16);
  }

  readBigInt(numBytes: number, le: boolean = false): bigint | null {
    let hex = this.readHex(numBytes);
    if (!hex) return null;
    if (le) {
      hex = hex.match(/../g)!.reverse().join('')
    }
    return BigInt('0x' + hex);
  }

  readSignedBigInt(numBytes: number, le: boolean = false): bigint | null {
    let unsignedNum = this.readBigInt(numBytes, le);
    const msbMask = (BigInt(1) << BigInt(numBytes * 8 - 1));
    if (unsignedNum && (unsignedNum & msbMask)) {

      unsignedNum -= BigInt(1) << BigInt(numBytes * 8);
    }

    return unsignedNum;
  }


  readBigIntArray(numElements: number, numBytesPerElement: number, le: boolean = false): bigint[] {
    const elements: bigint[] = [];
    for (let i = 0; i < numElements; ++i) {
      const num = this.readBigInt(numBytesPerElement, le);
      if (num == null) {
        break;
      }

      elements.push(num);
    }

    return elements;
  }

  readHexToTheEnd(): string | null {
    if (this.curIndex > this.data.length) {
      return null;
    }

    const res = this.data.slice(this.curIndex, this.data.length);
    this.curIndex = this.data.length;
    return res;
  }
}

export function toTwosComplementHex(num: bigint, numBytes: number): string {
  let hex;
  if (num < 0) {
    let val = BigInt(2) ** BigInt(numBytes * 8) + num;
    hex = val.toString(16);
  } else {
    hex = num.toString(16);
  }

  return padLeft(hex, numBytes * 2);
}

export function nodeToHex(node: TreeNode): string {
  const writer = new HexStringWriter();
  writer.writeNumber(node.height, 1);
  writer.writeNumber(node.index, 6);
  writer.writeBigInt(BigInt(node.value), 32);

  return writer.toString();
}

export function hexToNode(data: string): TreeNode | null {
  const reader = new HexStringReader(data);
  const height = reader.readNumber(1);
  const index = reader.readNumber(6);
  const value = reader.readBigInt(32);

  if (height != null && index != null && value != null) {
    return { height, index, value: value.toString()};
  }
  
  return null;
}

// 'from' boundaries are inclusively, 'to' ones are exclusively
export function isRangesIntersected(r1from: number, r1to: number, r2from: number, r2to: number): boolean {
  if (r1from < r1to && r2from < r2to && r1from < r2to && r1to > r2from) {
    return true;
  }
  return false;
}

export function rangesIntersectionLength(r1from: number, r1to: number, r2from: number, r2to: number): number {
  if (isRangesIntersected(r1from, r1to, r2from, r2to)) {
    const intersectStart = Math.max(r1from, r2from);
    const intersectEnd = Math.min(r1to, r2to);
    if (intersectEnd > intersectStart) {
      return intersectEnd - intersectStart;
    }
  }

  return 0;
}

export function assertNotNull<T>(val: T): asserts val is NonNullable<T> {
  if (val === undefined || val === null) {
      throw new InternalError('Unexpected null');
  }
}

export function removeDuplicates<T>(array: T[]): T[] {
  return array.reduce((acc: T[], cur: T) => {
      if (!acc.includes(cur)) {
          acc.push(cur);
      }
      return acc;
  }, [])
}