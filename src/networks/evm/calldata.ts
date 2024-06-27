import { InternalError } from "../../errors";
import { ShieldedTx, RegularTxType, TxCalldataVersion, CURRENT_CALLDATA_VERSION, RegularTxDetails } from "../../tx";
import { HexStringReader, addHexPrefix, assertNotNull, hexToBuf, toTwosComplementHex } from "../../utils";
import { PoolSelector } from ".";
import { NetworkBackend } from "..";


// Calldata components length universal reference
export class CalldataInfo {
  // from the selector to the memo (memo_size included)
  static baseLength(ver: TxCalldataVersion = CURRENT_CALLDATA_VERSION): number {
    switch (ver) {
      case TxCalldataVersion.V1: return 644;
      case TxCalldataVersion.V2: return 357;
      default: throw new InternalError(`[CalldataDecoder] Unknown calldata version: ${ver}`);
    }
  };

  // memo length (without notes)
  static memoBaseLength(txType: RegularTxType, ver: TxCalldataVersion = CURRENT_CALLDATA_VERSION): number {
    switch (ver) {
      case TxCalldataVersion.V1:
        switch (txType) {
          case RegularTxType.BridgeDeposit:
          case RegularTxType.Withdraw: 
            return 238;
          case RegularTxType.Deposit:
          case RegularTxType.Transfer:
            return 210;
          default: throw new InternalError(`[CalldataDecoder] Unknown transaction type: ${txType}`);
        }
      case TxCalldataVersion.V2:
        switch (txType) {
          case RegularTxType.BridgeDeposit:
          case RegularTxType.Withdraw:
            return 280;
          case RegularTxType.Deposit:
          case RegularTxType.Transfer:
            return 252;
          default: throw new InternalError(`[CalldataDecoder] Unknown transaction type: ${txType}`);
        }
      default: throw new InternalError(`[CalldataDecoder] Unknown calldata version: ${ver}`);
    }
  };

  static memoNoteLength(ver: TxCalldataVersion = CURRENT_CALLDATA_VERSION): number {
    return 172;
  };

  static depositSignatureLength(ver: TxCalldataVersion = CURRENT_CALLDATA_VERSION): number {
    return 64;
  };

  static memoTxSpecificFieldsLength(
    txType: RegularTxType,
    ver: TxCalldataVersion = CURRENT_CALLDATA_VERSION
  ): number {
    switch (ver) {
      case TxCalldataVersion.V1:
        switch (txType) {
          case RegularTxType.BridgeDeposit: return 8 + 8 + 20; // fee (u64) + deadline (u64) + holder (u160)
          case RegularTxType.Deposit: case RegularTxType.Transfer: return 8; // fee (u64)
          case RegularTxType.Withdraw: return 8 + 8 + 20; // fee (u64) + native_amount (u64) + address (u160)
          default: throw new InternalError(`[CalldataDecoder] Unknown transaction type: ${txType}`);
        }
      case TxCalldataVersion.V2:
        switch (txType) {
          case RegularTxType.BridgeDeposit:
            // proxy_address (u160) + prover_address (u160) + proxy_fee (u64) + prover_fee (u64) + 
            // + deadline (u64) + holder (u160)
            return 20 + 20 + 8 + 8 + 8 + 20;
          case RegularTxType.Deposit: case RegularTxType.Transfer:
            // proxy_address (u160) + prover_address (u160) + proxy_fee (u64) + prover_fee (u64)
            return 20 + 20 + 8 + 8;
          case RegularTxType.Withdraw:
            // proxy_address (u160) + prover_address (u160) + proxy_fee (u64) + prover_fee (u64) +
            // + native_amount (u64) + address (u160)
            return 20 + 20 + 8 + 8 + 8 + 20;
          default: throw new InternalError(`[CalldataDecoder] Unknown transaction type: ${txType}`);
        }
      default: throw new InternalError(`[CalldataDecoder] Unknown calldata version: ${ver}`);
    }
  }

  static estimateEvmCalldataLength(ver: TxCalldataVersion, txType: RegularTxType, notesCnt: number, extraDataLen: number = 0): number {
    let txSpecificLen = CalldataInfo.memoBaseLength(txType, ver);
    if (txType == RegularTxType.Deposit || txType == RegularTxType.BridgeDeposit) {
      txSpecificLen += CalldataInfo.depositSignatureLength(ver);
    }
  
    return CalldataInfo.baseLength(ver) + txSpecificLen + extraDataLen + notesCnt * CalldataInfo.memoNoteLength(ver);
  }
}

export function decodeEvmCalldata(calldata: string): ShieldedTx {
  const tx = new ShieldedTx();
  const reader = new HexStringReader(calldata);

  const selector = reader.readHex(4)?.toLowerCase()!;
  switch (selector) {
    case PoolSelector.Transact:
      tx.version = TxCalldataVersion.V1;
      break;
    case PoolSelector.TransactV2:
      tx.version = (reader.readNumber(1) as TxCalldataVersion);
      if (tx.version > CURRENT_CALLDATA_VERSION) {
        throw new InternalError('[CalldataDecoder] Unsupported calldata version');
      }
      break;
    default:
      throw new InternalError(`[CalldataDecoder] Cannot decode transaction: incorrect selector ${selector} (expected ${PoolSelector.Transact} or ${PoolSelector.TransactV2})`);
  };
  tx.nullifier = reader.readBigInt(32)!;
  tx.outCommit = reader.readBigInt(32)!;
  tx.transferIndex = reader.readBigInt(6)!;
  tx.energyAmount = reader.readSignedBigInt(14)!;
  tx.tokenAmount = reader.readSignedBigInt(8)!;
  tx.transactProof = reader.readBigIntArray(8, 32);

  if (selector == PoolSelector.Transact) {
    tx.rootAfter = reader.readBigInt(32)!;
    assertNotNull(tx.rootAfter);
    tx.treeProof = reader.readBigIntArray(8, 32);
  }
  
  tx.txType = reader.readHex(2) as RegularTxType;
  const memoSize = reader.readNumber(2);
  assertNotNull(memoSize);
  tx.memo = reader.readHex(memoSize)!;

  // Additional data appended to the end of calldata
  // It contains deposit holder signature for deposit transactions
  // or any other data which user can append
  tx.extra = reader.readHexToTheEnd()!;

  // verify all read successfully
  assertNotNull(tx.nullifier);
  assertNotNull(tx.outCommit);
  assertNotNull(tx.transferIndex);
  assertNotNull(tx.energyAmount);
  assertNotNull(tx.tokenAmount);
  assertNotNull(tx.version);
  assertNotNull(tx.txType);
  assertNotNull(tx.memo);
  assertNotNull(tx.extra);

  return tx;
}

export function getCiphertext(tx: ShieldedTx): string {
  let ciphertextStartOffset = CalldataInfo.memoTxSpecificFieldsLength(tx.txType, tx.version);
  if (tx.version == TxCalldataVersion.V2) {
    ciphertextStartOffset += 2; // message length field
  }
  return tx.memo.slice(ciphertextStartOffset * 2);
}

export async function parseTransactCalldata(calldata: string, network: NetworkBackend): Promise<RegularTxDetails> {
  const tx = decodeEvmCalldata(calldata);
  let feeAmount = 0n;
  switch (tx.version) {
      case TxCalldataVersion.V1:
          feeAmount = BigInt(addHexPrefix(tx.memo.slice(0, 16)));
          break;
      case TxCalldataVersion.V2:
          feeAmount = BigInt(addHexPrefix(tx.memo.slice(80, 96))) + 
                      BigInt(addHexPrefix(tx.memo.slice(96, 112)));
          break;
      default:
          throw new InternalError(`Unknown tx calldata version ${tx.version}`);
  }
  
  const txInfo = new RegularTxDetails();
  txInfo.txType = tx.txType;
  txInfo.tokenAmount = tx.tokenAmount;
  txInfo.feeAmount = feeAmount;
  txInfo.txHash = '';
  txInfo.isMined = false;
  txInfo.timestamp = 0;
  txInfo.nullifier = '0x' + toTwosComplementHex(BigInt((tx.nullifier)), 32);
  txInfo.commitment = '0x' + toTwosComplementHex(BigInt((tx.outCommit)), 32);
  txInfo.ciphertext = getCiphertext(tx);

  // additional tx-specific fields for deposits and withdrawals
  if (tx.txType == RegularTxType.Deposit) {
      if (tx.extra && tx.extra.length >= 128) {
          const fullSig = network.toCanonicalSignature(tx.extra.slice(0, 128));
          txInfo.depositAddr = await network.recoverSigner(txInfo.nullifier, fullSig);
      } else {
          // incorrect signature
          throw new InternalError(`No signature for approve deposit`);
      }
  } else if (tx.txType == RegularTxType.BridgeDeposit) {
      if (tx.version == TxCalldataVersion.V1) {
          txInfo.depositAddr = network.bytesToAddress(hexToBuf(tx.memo.slice(32, 72), 20));
      } else if (tx.version == TxCalldataVersion.V2) {
          txInfo.depositAddr = network.bytesToAddress(hexToBuf(tx.memo.slice(128, 168), 20));
      }
  } else if (tx.txType == RegularTxType.Withdraw) {
      if (tx.version == TxCalldataVersion.V1) {
          txInfo.withdrawAddr = network.bytesToAddress(hexToBuf(tx.memo.slice(32, 72), 20));
      } else if (tx.version == TxCalldataVersion.V2) {
          txInfo.withdrawAddr = network.bytesToAddress(hexToBuf(tx.memo.slice(128, 168), 20));
      }
  }

  return txInfo;
}