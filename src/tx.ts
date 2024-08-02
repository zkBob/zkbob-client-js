import { InternalError } from "./errors";

// Just available for the regular transactions
export enum TxCalldataVersion {
  V1 = 1, // original tx format
  V2 = 2, // new tx format (decentalized proxies deployment)
          // this format doesn't include rootAfter and treeProof
}

export const CURRENT_CALLDATA_VERSION = TxCalldataVersion.V2;

export enum RegularTxType {
  Deposit = '0000',
  Transfer = '0001',
  Withdraw = '0002',
  BridgeDeposit = '0003',
}

export function txTypeToString(txType: RegularTxType): string {
  switch (txType) {
    case RegularTxType.Deposit: return 'deposit';
    case RegularTxType.Transfer: return 'transfer';
    case RegularTxType.Withdraw: return 'withdraw';
    case RegularTxType.BridgeDeposit: return 'bridge-deposit';
  }
}

// The raw low-level transaction data used on most networks
export class ShieldedTx {
  version: TxCalldataVersion;
  nullifier: bigint;
  outCommit: bigint;
  transferIndex: bigint;
  energyAmount: bigint;
  tokenAmount: bigint;
  transactProof: bigint[];
  rootAfter: bigint;
  treeProof: bigint[];
  txType: RegularTxType;
  memo: string;
  extra: string;
}

// Transaction states supported by sequencer
export enum TxState {
  SentCommit = 0, // tx was sent to the pool and included to the optimistic state
  Committed = 2,  // tx was sequenced but not finalized yet
                  // (this state is available in decentralized proxy deployments only)
  Finalized = 1,  // tx was mined and included in the pool state
}
export function txStateFrom(raw: number): TxState {
  if (raw >= 0 && raw <= 2) {
    return raw as TxState
  }
  
  throw new InternalError(`Cannot create TxState from raw value ${raw}`);
}

// Minimal required pool transaction info
// needed to restore local state
export class PoolTxMinimal {
  index: number;
  commitment: string; // hex (without 0x prefix)
  txHash: string; // needed to retrieve PoolTxDetails
  memo: string;   // hex (without 0x prefix)
  state: TxState;
}

// The top-level transaction details needed in the client library (HistoryStorage for example)
export enum PoolTxType {
  Regular,
  DirectDepositBatch,
}

export interface PoolTxDetails {
  poolTxType: PoolTxType,
  details: RegularTxDetails | DDBatchTxDetails,
  index: number,  // index of the first tx leaf in the Merkle tree
}

// These fields belongs to the concrete transaction which are extracted
// from the blockchain (or subraph) and needed to create a HistoryRecord
export class CommonTxDetails {
  txHash: string;         // to the pool contract
  isMined: boolean;
  timestamp: number;
}

export class RegularTxDetails extends CommonTxDetails {
  txType: RegularTxType;  // deposit, transfer, withdraw, permit deposit
  tokenAmount: bigint;
  feeAmount: bigint;      // sequencer's reward
  depositAddr?: string;   // for deposit txs only
  withdrawAddr?: string;  // for withdraw txs only
  // The following fields are needed for compliance report
  commitment: string;     // 0x-prefixed hex format
  nullifier: string;      // 0x-prefixed hex format
  ciphertext: string;     // 0x-prefixed hex format
}

export enum DirectDepositState {
  Queued,
  Deposited,
  Refunded,
}

export interface DDPaymentInfo {
  note: string | null;
  sender: string;
  token: string;
}

export interface DirectDeposit {
  id: bigint;            // DD queue unique identifier
  state: DirectDepositState;
  amount: bigint;        // in pool resolution
  destination: string;   // zk-addresss
  fee: bigint;           // sequencer fee
  fallback: string;      // 0x-address to refund DD
  sender: string;        // 0x-address of sender [to the queue]
  queueTimestamp: number;// when it was created
  queueTxHash: string;   // transaction hash to the queue
  timestamp?: number;    // when it was sent to the pool
  txHash?: string;       // transaction hash to the pool
  payment?: DDPaymentInfo;
}

export class DDBatchTxDetails extends CommonTxDetails {
  deposits: DirectDeposit[];
}