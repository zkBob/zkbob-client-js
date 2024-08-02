import { openDB, IDBPDatabase } from 'idb';
import { Account, Note, TxMemoChunk, IndexedTx, ParseTxsResult, TxInput } from 'libzkbob-rs-wasm-web';
import { DDBatchTxDetails, PoolTxDetails, PoolTxType, RegularTxDetails, RegularTxType } from './tx';
import { HexStringWriter, hexToBuf, removeDuplicates } from './utils';
import { CONSTANTS } from './constants';
import { InternalError } from './errors';
import { ZkBobState } from './state';
import { NetworkBackend } from './networks';
import { ZkBobSubgraph } from './subgraph';
import { SequencerJob } from './services/relayer';

const LOG_HISTORY_SYNC = false;
const MAX_SYNC_ATTEMPTS = 3;  // if sync was not fully completed due to RPR errors

const HISTORY_RECORD_VERSION = 3; // used to upgrade history records format in the database

export enum HistoryTransactionType {
  Deposit = 1,
  TransferIn,
  TransferOut,
  Withdrawal,
  AggregateNotes,
  DirectDeposit,
}

export enum HistoryRecordState {
  Pending = 1,
  Mined,
  RejectedByRelayer,
  RejectedByPool,
}

export interface RevealedMemo {
  index: number;
  encChunks: { data: Uint8Array, index: number }[]; // chunk: encrypted account or note
  ecdhKeys:  { key: Uint8Array, index: number }[];  // keys to decrypting chunks at the corresponding indexes
}

export interface DecryptedMemo {
  index: number;
  acc: Account | undefined;
  inNotes:  { note: Note, index: number }[];
  outNotes: { note: Note, index: number }[];
  txHash: string | undefined;
}

export interface TokensMoving {
  from: string,
  to: string,
  amount: bigint,
  ddFee?: bigint, // for direct deposits only
  // This property is applicable only for outcoming transfers
  // true - destination address is belongs to the sender account
  isLoopback: boolean,
}

export class HistoryRecord {
  constructor(
    public type: HistoryTransactionType,
    public commitment: bigint, // transaction identification
    public timestamp: number,
    public actions: TokensMoving[],
    public fee: bigint,
    public txHash: string,
    public state: HistoryRecordState,
    public failureReason?: string,
    public extraInfo?: any,
  ) {}

  public static async deposit(
    from: string,
    amount: bigint,
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    commitment?: bigint,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const action: TokensMoving = {from, to: "", amount, isLoopback: false};
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.Deposit, commitment ?? 0n, ts, [action], fee, txHash, state, undefined, extraInfo);
  }

  public static async transferIn(
    transfers: {to: string, amount: bigint}[],
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    commitment?: bigint,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const actions: TokensMoving[] = transfers.map(({to, amount}) => { return ({from: "", to, amount, isLoopback: false}) });
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.TransferIn, commitment ?? 0n, ts, actions, fee, txHash, state, undefined, extraInfo);
  }

  public static async transferOut(
    transfers: {to: string, amount: bigint}[],
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    getIsLoopback: (shieldedAddress: string) => Promise<boolean>,
    commitment?: bigint,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const actions: TokensMoving[] = await Promise.all(transfers.map(async ({to, amount}) => { 
      return ({from: "", to, amount, isLoopback: await getIsLoopback(to)})
    }));
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.TransferOut, commitment ?? 0n, ts, actions, fee, txHash, state, undefined, extraInfo);
  }

  public static async withdraw(
    to: string,
    amount: bigint,
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    commitment?: bigint,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const action: TokensMoving = {from: "", to, amount, isLoopback: false};
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.Withdrawal, commitment ?? 0n, ts, [action], fee, txHash, state, undefined, extraInfo);
  }

  public static async aggregateNotes(
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    commitment?: bigint,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.AggregateNotes, commitment ?? 0n, ts, [], fee, txHash, state, undefined, extraInfo);
  }

  public static async directDeposit(
    from: string,
    to: string,
    amount: bigint,
    fee: bigint,
    ts: number,
    txHash: string,
    pending: boolean,
    extraInfo?: any,
  ): Promise<HistoryRecord> {
    const actions: TokensMoving[] = [ {from, to, amount, isLoopback: false} ];
    const state: HistoryRecordState = pending ? HistoryRecordState.Pending : HistoryRecordState.Mined;
    return new HistoryRecord(HistoryTransactionType.DirectDeposit, 0n, ts, actions, fee, txHash, state, undefined, extraInfo);
  }

  public toJson(): string {
    return JSON.stringify(this, (_, v) => typeof v === 'bigint' ? `${v}n` : v)
        .replace(/"(-?\d+)n"/g, (_, a) => a);
  }
}

class HistoryRecordIdx {
  index: number;
  record: HistoryRecord;

  public static create(record: HistoryRecord, index: number): HistoryRecordIdx {
    const result = new HistoryRecordIdx();
    result.index = index;
    result.record = record;

    return result;
  }
}

export class ComplianceHistoryRecord extends HistoryRecord {
  // the first leaf (account) index
  public index: number;
  // used to chaining accounts
  // nullifiers are undefined for incoming transfers
  public nullifier?: Uint8Array; // for the input account
  public nextNullifier?: Uint8Array; // for the output account (will be used in the next tx)
  // encrypted elements (chunk: encrypted account or note)
  public encChunks: { data: Uint8Array, index: number }[];
  // keys to decrypting chunks at the corresponding indexes
  public ecdhKeys:  { key: Uint8Array, index: number }[];
  // decrypted elements
  public acc?: Account;
  // decrypted notes
  public notes:  { note: Note, index: number }[]; // incoming notes (TransferIn case)
  // transaction inputs (undefined for incoming txs)
  public inputs?: {
    account: {index: number, account: Account},
    intermediateNullifier: string,
    notes: {index: number, note: Note}[],
  };

  constructor(
    rec: HistoryRecord,
    index: number,
    nullifier: Uint8Array | undefined,  // undefined for incoming transfers
    nextNullifier: Uint8Array | undefined, // undefined for incoming transfers
    memo: DecryptedMemo,
    chunks: TxMemoChunk[],
    inputs: TxInput | undefined, // undefined for incoming transfers
  ) {
    super(rec.type, rec.commitment, rec.timestamp, rec.actions, rec.fee, rec.txHash, rec.state, rec.failureReason);

    this.index = index;
    this.nullifier = nullifier;
    this.nextNullifier = nextNullifier;
    this.encChunks = chunks.map(aChunk => { return {data: new Uint8Array(aChunk.encrypted), index: aChunk.index} });
    this.ecdhKeys = chunks.map(aChunk => { return {key: new Uint8Array(aChunk.key), index: aChunk.index} });
    this.acc = memo.acc;
    this.notes = [...memo.inNotes,
                  ...memo.outNotes.filter(aNote => 
                      // in case of loopback transfer the associated notes
                      // can persist in the both arrays (IN/OUT)
                      // so we should to avoid notes duplications
                      memo.inNotes.find(anotherNote => 
                        aNote.index == anotherNote.index
                      ) === undefined
                    )
                  ];
    this.inputs = inputs;
  }
}


const TX_TABLE = 'TX_STORE';
const TX_FAILED_TABLE = 'TX_FAILED_STORE';
const DECRYPTED_MEMO_TABLE = 'DECRYPTED_MEMO';
const DECRYPTED_PENDING_MEMO_TABLE = 'DECRYPTED_PENDING_MEMO';
const HISTORY_STATE_TABLE = 'HISTORY_STATE';
const NATIVE_TX_TABLE = 'NATIVE_TX';

// History storage holds the parsed history records corresponding to the current account
// and transaction hashes (on the native chain) which are needed for the history retrieving

export class HistoryStorage {
  private db: IDBPDatabase;
  private syncIndex = -1;
  private syncAttempts = 0;
  private state: ZkBobState;
  private network: NetworkBackend;
  private subgraph?: ZkBobSubgraph;

  private queuedTxs = new Map<string, HistoryRecord[]>(); // job -> HistoryRecord[]
                                          //(while tx isn't processed on sequencer)
                                          // We don't know txHash for history records at that moment
                                          // Please keep in mind that one job contain just one txHash,
                                          // but transaction in common case could consist of several HistoryRecords
                                          // (e.g. deposit + transfer, unimplemented case currently)

  private sentTxs = new Map<string, HistoryRecord[]>(); // txHash -> HistoryRecord[]
                                          // (while we have a hash from relayer but it isn't indexed on RPC JSON)
                                          // At that moment we should fill txHash for every history record correctly

  private unparsedMemo = new Map<number, DecryptedMemo>();  // local decrypted memos cache
  private unparsedPendingMemo = new Map<number, DecryptedMemo>();  // local decrypted pending memos cache
  
  private currentHistory = new Map<number, HistoryRecord>();  // local history cache (index -> HistoryRecord)
  private failedHistory: HistoryRecord[] = [];  //  local failed history cache (we have no key here, just array)
  private pendingLocalHistory: HistoryRecord[] = [];  // sent transactions which were not included in sequencer's state yet


  private syncHistoryPromise: Promise<void> | undefined;


  constructor(db: IDBPDatabase, network: NetworkBackend, state: ZkBobState, subgraph?: ZkBobSubgraph) {
    this.db = db;
    this.network = network;
    this.state = state;
    this.subgraph = subgraph;
  }

  static async init(db_id: string, network: NetworkBackend, state: ZkBobState, subgraph?: ZkBobSubgraph): Promise<HistoryStorage> {
    let isNewDB = false;
    const db = await openDB(`zkb.${db_id}.history`, 4, {
      upgrade(db, oldVersion, newVersions) {
        if (oldVersion < 2) {
          db.createObjectStore(TX_TABLE);   // table holds parsed history transactions
          db.createObjectStore(DECRYPTED_MEMO_TABLE);  // holds memo blocks decrypted in the updateState process
          db.createObjectStore(DECRYPTED_PENDING_MEMO_TABLE);  // holds memo blocks decrypted in the updateState process, but not mined yet
          db.createObjectStore(HISTORY_STATE_TABLE);   
        }
        if (oldVersion < 3) {
          db.createObjectStore(TX_FAILED_TABLE, {autoIncrement: true});
        }
        if (oldVersion < 4) {
          db.createObjectStore(NATIVE_TX_TABLE);
        }

        if (oldVersion == 0 ) {
          isNewDB = true;
        }
      }
    });

    // Working with the internal records version
    const savedVersion: number = await db.get(HISTORY_STATE_TABLE, 'version');
    if (!savedVersion || savedVersion < HISTORY_RECORD_VERSION) {
      if (!savedVersion && !isNewDB) {
        // upgrade existig history records if needed
        // we should make it once to prevent history scanning on the each initialization
        let cursor = await db.transaction(TX_TABLE, "readwrite").store.openCursor();
        let oldAddressDetected = false;
        while (cursor && !oldAddressDetected) {
          const curRecord: HistoryRecord = cursor.value;
          if (curRecord.actions) {
            for (const aRec of curRecord.actions) {
              if (!aRec.from.startsWith('0x') && aRec.from.includes(':') == false ||
                  !aRec.to.startsWith('0x') && aRec.to.includes(':') == false)
              { // old address detected
                oldAddressDetected = true;
                break;
              }
            }
            console.log(`[HistoryStorage] old history record was found! Clean deprecated records...`);
          }
          cursor = await cursor.continue();
        }

        if (oldAddressDetected) {
          console.warn(`[HistoryStorage] old history record was found! Cleaning history to rebuilt it...`);
          await db.clear(TX_TABLE);
          await db.delete(HISTORY_STATE_TABLE, 'sync_index');
          await db.delete(HISTORY_STATE_TABLE, 'fail_indexes');
        } else {
          console.info(`[HistoryStorage] history was scanned for the old addresses, no matches were found`);
        }
      }
      
      await db.put(HISTORY_STATE_TABLE, HISTORY_RECORD_VERSION, 'version');
    }

    const storage = new HistoryStorage(db, network, state, subgraph);
    await storage.preloadCache();

    return storage;
  }

  public async preloadCache() {
    const syncIndex:number = await this.db.get(HISTORY_STATE_TABLE, 'sync_index');
    if (syncIndex ) {
      this.syncIndex = syncIndex;
    }

    // getting unprocessed memo arrays (greater than sync index)
    const allUnprocessedMemos: DecryptedMemo[] = await this.db.getAll(DECRYPTED_MEMO_TABLE, IDBKeyRange.lowerBound(this.syncIndex + 1));
    const allUnprocessedPendingMemos: DecryptedMemo[] = await this.db.getAll(DECRYPTED_PENDING_MEMO_TABLE, IDBKeyRange.lowerBound(this.syncIndex + 1));
    let lastMinedMemoIndex = -1;
    for (const oneMemo of allUnprocessedMemos) {
      this.unparsedMemo.set(oneMemo.index, oneMemo);
      if (oneMemo.index > lastMinedMemoIndex) {
        lastMinedMemoIndex = oneMemo.index; // get the max mined memo index
      }
    }
    for (const oneMemo of allUnprocessedPendingMemos) {
      if (oneMemo.index > lastMinedMemoIndex) { // skip outdated unparsed memos
        this.unparsedPendingMemo.set(oneMemo.index, oneMemo);
      }
    }
    
    // getting saved history records
    let cursor = await this.db.transaction(TX_TABLE).store.openCursor();
    while (cursor) {
      const curRecord = cursor.value;
      if (curRecord.actions === undefined || curRecord.commitment === undefined) {
        console.log(`[HistoryStorage] old history record was found! Clean deprecated records...`);
        await this.db.clear(TX_TABLE);
        await this.cleanIndexes();
        return this.preloadCache();
      }
      this.currentHistory.set(Number(cursor.primaryKey), cursor.value);
      cursor = await cursor.continue();
    }

    // getting failed history records
    this.failedHistory = await this.db.getAll(TX_FAILED_TABLE);

    // getting failured memo list and include it in unprocessed one
    // (memos which are placed below syncIndex but wasn't converted to the HistoryRecord for any reason)
    const failSyncRecords: number[] = await this.db.get(HISTORY_STATE_TABLE, 'fail_indexes');
    if (failSyncRecords) {
      await Promise.all(failSyncRecords.map(async (idx) => {
        const lostMemo: DecryptedMemo = await this.db.get(DECRYPTED_MEMO_TABLE, idx);
        if (lostMemo) {
          this.unparsedMemo.set(idx, lostMemo);
          console.log(`[HistoryStorage] found lost memo @${idx}`);
        } else {
          console.warn(`[HistoryStorage] memo @${idx} was marked as lost but no source memo was found`);
        }
      }));
    } else {
      // It's seems we faced with that array for the first time
      // Let's check all history for the leaked records
      console.log(`[HistoryStorage] checking history for the lost records...`);
      // we assume that every unprocessed memo should have associated HistoryRecord with the same index
      let recIndexes = [...this.currentHistory.keys()];
      let cursor = await this.db.transaction(DECRYPTED_MEMO_TABLE).store.openCursor();
      while (cursor) {
        if (!recIndexes.includes(Number(cursor.primaryKey))) {
          console.warn(`[HistoryStorage] found lost which has no associated HistoryRecord @${Number(cursor.primaryKey)}`);
          this.unparsedMemo.set(Number(cursor.primaryKey), cursor.value);
        }
        cursor = await cursor.continue();
      }
    }

    console.log(`[HistoryStorage] preload ${this.currentHistory.size} history records, ${this.unparsedMemo.size} + ${this.unparsedPendingMemo.size}(pending) unparsed memos (synced from ${this.syncIndex + 1})`);
  }

  public async getAllHistory(): Promise<HistoryRecord[]> {
    if (this.syncHistoryPromise == undefined) {
      this.syncHistoryPromise = new Promise<void>(async (resolve) => {
        this.syncAttempts = 0;
        let result = false;
        do {
          if (this.syncAttempts++ > 0) {
            console.warn(`[HistoryStorage] history retry attempt #${this.syncAttempts} (${this.unparsedMemo.size} memo were not converted yet)`);
          }
          result = await this.syncHistory();
          if (result) {
            break;
          }
        } while(this.syncAttempts < MAX_SYNC_ATTEMPTS);

        if (!result) {
          console.warn(`[HistoryStorage] cannot fully sync history after ${this.syncAttempts} attempts (${this.unparsedMemo.size} memo were not converted yet)`);
        }
        resolve();
      }).catch((err) => {
        console.error(`[HistoryStorage]: unexpected error occured during history sync: ${err.message}`);
      }).finally(() => {
        this.syncHistoryPromise = undefined;
      });
    }

    await this.syncHistoryPromise;

    return Array.from(this.currentHistory.values())
            .concat(this.failedHistory)
            .concat(this.pendingLocalHistory)
            .sort((rec1, rec2) => 0 - (rec1.timestamp > rec2.timestamp ? -1 : 1));
  }

  // remember just sent transactions to restore history record immediately
  public keepQueuedTransactions(txs: HistoryRecord[], job: SequencerJob) {
    this.queuedTxs.set(job.hash(), txs);
  }

  // A new txHash assigned for the jobId:
  // set txHash mapping for awaiting transactions
  public setTxHashForQueuedTransactions(job: SequencerJob, txHash: string) {
    const records = this.queuedTxs.get(job.hash());
    if (records !== undefined) {
      // Get history records associated with job
      // and assign new txHash for them
      const sentHistoryRecords: HistoryRecord[] = [];
      let oldTxHash = '';
      for(const aRec of records) {
        if (oldTxHash.length == 0 && aRec.txHash && aRec.txHash.startsWith('0x')){
          // note: all history records inside jobId should have the same txHash
          oldTxHash = aRec.txHash;
        }

        aRec.txHash = txHash; // sinse 'record' and 'aRec' are references
                              // txHash will changed in queuedTxs too
        sentHistoryRecords.push(aRec);
      }

      if (oldTxHash != txHash) {
        // Here is a case when txHash has been changed for existing job:
        // we should remove records from sentTxs with old txHash
        this.removePendingTxByTxHash(oldTxHash);
      }

      // set history records in the sentTx mapping
      this.sentTxs.set(txHash, sentHistoryRecords);
    }
  }

  // Mark job as completed: remove it from 'queuedTxs' and 'sentTxs' mappings
  public async setQueuedTransactionsCompleted(job: SequencerJob, txHash: string) : Promise<boolean> {
    return this.removePendingTxByJob(job) || 
            this.removePendingTxByTxHash(txHash);
  }

  // mark pending transaction as failed on the relayer level (we shouldn't have txHash here)
  public async setQueuedTransactionFailedByRelayer(job: SequencerJob, error: string | undefined): Promise<boolean> {
    const records = this.queuedTxs.get(job.hash());
    if (records) {
      // moving all records from that job to the failedHistory table
      for(const aRec of records) {
        aRec.state = HistoryRecordState.RejectedByRelayer;
        aRec.failureReason = error;

        this.failedHistory.push(aRec);
        await this.db.put(TX_FAILED_TABLE, aRec);
      }    

      this.removePendingTxByJob(job);

      return true;
    }

    return false;
  }

  // mark pending transaction as failed on the relayer level
  public async setSentTransactionFailedByPool(job: SequencerJob, txHash: string, error: string | undefined): Promise<boolean> {
    // try to locate txHash in sentTxs
    const txs = this.sentTxs.get(txHash);
    if (txs) {
      for(const oneTx of txs) {
        oneTx.state = HistoryRecordState.RejectedByPool;
        oneTx.failureReason = error;

        this.failedHistory.push(oneTx);
        await this.db.put(TX_FAILED_TABLE, oneTx);
      }    

      this.removePendingTxByJob(job);
      this.removePendingTxByTxHash(txHash);
      this.removeHistoryPendingRecordsByTxHash(txHash);

      return true;
    }

    // txHash of that transaction can be changed
    // => locate it in queuedTxs map by job
    const records = this.queuedTxs.get(job.hash());
    if (records) {
      // moving all records from that job to the failedHistory table
      let oldTxHash = '';
      for(const aRec of records) {
        if (oldTxHash.length == 0 && aRec.txHash.startsWith('0x')) {
          oldTxHash = aRec.txHash;
        }
        aRec.state = HistoryRecordState.RejectedByPool;
        aRec.failureReason = error;
        aRec.txHash = txHash;

        this.failedHistory.push(aRec);
        await this.db.put(TX_FAILED_TABLE, aRec);
      }    

      this.removePendingTxByJob(job);
      if (oldTxHash.startsWith('0x')) {
        this.removeHistoryPendingRecordsByTxHash(oldTxHash);
      }

      return true;
    }

    return false;
  }

  private removePendingTxByJob(job: SequencerJob): boolean {
    const records = this.queuedTxs.get(job.hash());
    if (records) {
      this.queuedTxs.delete(job.hash());

      // remove associated records from the sentTxs
      for(const aRec of records) {
        if (aRec.txHash.startsWith('0x')) {
          this.sentTxs.delete(aRec.txHash);
        }
      }

      return true;
    }

    return false;
  }

  private removePendingTxByTxHash(txHash: string): boolean {
    // remove records from the sentTxs by txHash
   let res = this.sentTxs.delete(txHash);

    // remove queued txs with the same txHash
    this.queuedTxs.forEach((records, jobHash) => {
      for (const aRec of records) {
        if (aRec.txHash == txHash) {
          this.queuedTxs.delete(jobHash);
          res = true;
        }
      }
    });

    return res;
  }

  // remove pending transactions with the txHash
  private removeHistoryPendingRecordsByTxHash(txHash: string): boolean {
    let deleted = false;
    for (const [index, record] of this.currentHistory) {
      if (record.state == HistoryRecordState.Pending && record.txHash == txHash) {
        deleted ||= this.currentHistory.delete(index);
      }
    }

    return deleted;
  }

  public async saveDecryptedMemo(memo: DecryptedMemo, pending: boolean): Promise<DecryptedMemo> {
    const mask = (-1) << CONSTANTS.OUTLOG;
    const memoIndex = memo.index & mask;

    if (pending) {
      this.unparsedPendingMemo.set(memoIndex, memo);
      await this.db.put(DECRYPTED_PENDING_MEMO_TABLE, memo, memoIndex);
    } else {
      if (memo.index > this.syncIndex) {
        this.unparsedMemo.set(memoIndex, memo);
      }
      await this.db.put(DECRYPTED_MEMO_TABLE, memo, memoIndex);
    }

    return memo;
  }

  public async getDecryptedMemo(index: number, allowPending: boolean): Promise<DecryptedMemo | null> {
    const mask = (-1) << CONSTANTS.OUTLOG;
    const memoIndex = index & mask;

    let memo = await this.db.get(DECRYPTED_MEMO_TABLE, memoIndex);
    if (memo === null && allowPending) {
      memo = await this.db.get(DECRYPTED_PENDING_MEMO_TABLE, memoIndex);
    }
    return memo;
  }

  public async setLastMinedTxIndex(index: number): Promise<void> {
    for (const oneKey of this.unparsedPendingMemo.keys()) {
      if (oneKey <= index) {
        this.unparsedPendingMemo.delete(oneKey);
      }
    }

    await this.db.delete(DECRYPTED_PENDING_MEMO_TABLE, IDBKeyRange.upperBound(index));
  }

  public async setLastPendingTxIndex(index: number): Promise<void> {
    for (const oneKey of this.unparsedPendingMemo.keys()) {
      if (oneKey > index) {
        this.unparsedPendingMemo.delete(oneKey);
      }
    }

    await this.db.delete(DECRYPTED_PENDING_MEMO_TABLE, IDBKeyRange.lowerBound(index, true));
  }

  // the history should be synced before invoking that method
  // timestamps are milliseconds, low bound is inclusively
  public async getComplianceReport(fromTimestamp: number | null, toTimestamp: number | null): Promise<ComplianceHistoryRecord[]> {
    let complienceRecords: ComplianceHistoryRecord[] = [];
    
    for (const [treeIndex, value] of  this.currentHistory.entries()) {
      const recTs = value.timestamp * 1000;
      if (recTs >= (fromTimestamp ?? 0) &&
          recTs < (toTimestamp ?? Number.MAX_VALUE) &&
          value.state == HistoryRecordState.Mined
      ) {
        const txDetails = await this.network.getTxDetails(treeIndex, value.txHash, this.state);
        const details = txDetails?.details;
        if (txDetails && details instanceof RegularTxDetails) {  // txDetails belongs to a regular transaction
          // regular transaction
          const memoblock = hexToBuf(details.ciphertext);

          let decryptedMemo = await this.getDecryptedMemo(treeIndex, false);
          if (!decryptedMemo) {
            // If the decrypted memo cannot be retrieved from the database => decrypt it again
            const indexedTx: IndexedTx = {
              index: treeIndex,
              memo: details.ciphertext,
              commitment: details.commitment,
            }
            const res: ParseTxsResult = await this.state.decryptMemos(indexedTx);
            if (res.decryptedMemos.length == 1) {
              decryptedMemo = res.decryptedMemos[0];
            } else {
              throw new InternalError(`Cannot decrypt tx. Excepted 1 memo, got ${res.decryptedMemos.length}`);
            }
          }

          const chunks: TxMemoChunk[] = await this.state.extractDecryptKeys(treeIndex, memoblock);

          let nullifier: Uint8Array | undefined;
          let inputs: TxInput | undefined;
          let nextNullifier: Uint8Array | undefined;
          if (value.type != HistoryTransactionType.TransferIn) {
            // tx is user-initiated
            nullifier = hexToBuf(details.nullifier);
            inputs = await this.state.getTxInputs(treeIndex);
            if (decryptedMemo && decryptedMemo.acc) {
              const strNullifier = await this.state.calcNullifier(decryptedMemo.index, decryptedMemo.acc);
              const writer = new HexStringWriter();
              writer.writeBigInt(BigInt(strNullifier), 32);
              nextNullifier = hexToBuf(writer.toString());
            } else {
              throw new InternalError(`Account was not decrypted @${treeIndex}`);
            }
          }
          
          const aRec = new ComplianceHistoryRecord(value, treeIndex, nullifier, nextNullifier, decryptedMemo as DecryptedMemo, chunks, inputs);
          complienceRecords.push(aRec);
        } else if (txDetails && details instanceof DDBatchTxDetails) { // txDetails belongs to direct deposit batch
          // Here is direct deposit batch transaction
          // It isn't encrypted so we do not need any extra info
          let decryptedMemo = await this.getDecryptedMemo(treeIndex, false);
          if (decryptedMemo) {
            const aRec = new ComplianceHistoryRecord(value, treeIndex, undefined, undefined, decryptedMemo, [], undefined);
            complienceRecords.push(aRec);
          }
        } else {  // cannot retrieve transaction details
          throw new InternalError(`Cannot retrieve tx details @ ${treeIndex}`)
        }
      }
    };

    return complienceRecords;
  }

  public async rollbackHistory(rollbackIndex: number): Promise<void> {
    if (this.syncHistoryPromise) {
      // wait while sync is finished (if started)
      await this.syncHistoryPromise;
    }

    // rollback local objects
    this.currentHistory.forEach((_value: HistoryRecord, key: number) => {
      if (key >= rollbackIndex) {
        this.currentHistory.delete(key);
      }
    });
    let new_sync_index = -1;
    this.unparsedMemo.forEach((_value: DecryptedMemo, key: number) => {
      if (key >= rollbackIndex) {
        this.unparsedMemo.delete(key);
      } else if (key > new_sync_index) {
        new_sync_index = key;
      }
    });
    this.unparsedPendingMemo.forEach((_value: DecryptedMemo, key: number) => {
      if (key >= rollbackIndex) {
        this.unparsedPendingMemo.delete(key);
      }
    });


    // Remove records after the specified index from the database
    await this.db.delete(TX_TABLE, IDBKeyRange.lowerBound(rollbackIndex));
    await this.db.delete(DECRYPTED_MEMO_TABLE, IDBKeyRange.lowerBound(rollbackIndex));
    await this.db.delete(DECRYPTED_PENDING_MEMO_TABLE, IDBKeyRange.lowerBound(rollbackIndex));
    await this.db.delete(NATIVE_TX_TABLE, IDBKeyRange.lowerBound(rollbackIndex));

    // update sync_index
    this.syncIndex = new_sync_index
    if (this.syncIndex < 0) {
      this.db.delete(HISTORY_STATE_TABLE, 'sync_index');
    } else {
      this.db.put(HISTORY_STATE_TABLE, this.syncIndex, 'sync_index');
    }

    // remove failed indexes if needed
    let failSyncRecords: number[] = await this.db.get(HISTORY_STATE_TABLE, 'fail_indexes');
    if (failSyncRecords) {
      failSyncRecords = failSyncRecords.filter(idx => idx < rollbackIndex);
      await this.db.put(HISTORY_STATE_TABLE, failSyncRecords, 'fail_indexes');
    }
  }

  public async cleanHistory(): Promise<void> {
    if (this.syncHistoryPromise) {
      // wait while sync is finished (if started)
      await this.syncHistoryPromise;
    }

    // Remove all records from the database
    await this.db.clear(TX_TABLE);
    await this.db.clear(TX_FAILED_TABLE);
    await this.db.clear(DECRYPTED_MEMO_TABLE);
    await this.db.clear(DECRYPTED_PENDING_MEMO_TABLE);
    await this.db.clear(NATIVE_TX_TABLE);
    await this.cleanIndexes();

    // Clean local cache
    this.unparsedMemo.clear();
    this.unparsedPendingMemo.clear();
    this.currentHistory.clear();
    this.failedHistory = [];
  }

  private async cleanIndexes(): Promise<void> {
    await this.db.delete(HISTORY_STATE_TABLE, 'sync_index');
    await this.db.delete(HISTORY_STATE_TABLE, 'fail_indexes');
    this.syncIndex = -1;
  }

  // ------- Private routines --------

  // Returns true if there is all unparsed memo were converted to the HistoryRecords
  // If one or more transactions were postponed due to recoverable error - return false
  // Pending transactions are not influence on the return value (in case of error it will re-fetched in the next time)
  // The method can be throw an error in case of unrecoverable error

  private async syncHistory(): Promise<boolean> {
    const startTime = Date.now();

    if (this.unparsedMemo.size > 0 || this.unparsedPendingMemo.size > 0) {
      console.log(`[HistoryStorage] starting memo synchronizing from the index ${this.syncIndex + 1} (${this.unparsedMemo.size} + ${this.unparsedPendingMemo.size}(pending) unprocessed memos)`);

      //const historyPromises: Promise<HistoryRecordIdx[]>[] = [];
      
      // process mined memos
      const minedHistoryPromise = this.convertToHistory([...this.unparsedMemo.values()], false);
      const pendingHistoryPromise = this.convertToHistory([...this.unparsedPendingMemo.values()], true);
      const [minedHistory, pendingHistory] = await Promise.all([minedHistoryPromise, pendingHistoryPromise]);


      const historyRecords = minedHistory.records.concat(pendingHistory.records);
      const processedIndexes = minedHistory.succIdxs.concat(pendingHistory.succIdxs);
      const unprocessedIndexes = minedHistory.failIdxs.concat(pendingHistory.failIdxs);
      const needToResyncIndexes = minedHistory.resyncIdxs.concat(pendingHistory.resyncIdxs);

      // delete all pending history records [we'll refresh them immediately]
      for (const [index, record] of this.currentHistory.entries()) {
        if (record.state == HistoryRecordState.Pending) {
          this.currentHistory.delete(index);
        }
      }

      let newSyncIndex = this.syncIndex;
      for (const oneRec of historyRecords) {
        if (LOG_HISTORY_SYNC) {
          console.log(`[HistoryStorage] history record @${oneRec.index} has been created`);
        }

        this.currentHistory.set(oneRec.index, oneRec.record);

        if (oneRec.record.state == HistoryRecordState.Mined) {
          // save history record only for mined transactions
          this.put(oneRec.index, oneRec.record);
          
          newSyncIndex = oneRec.index;
        }
      }

      if (unprocessedIndexes.length > 0) {
        console.warn(`[HistoryStorage] unable to sync indexes: ${unprocessedIndexes.sort().map((idx) => `@${idx}`).join(', ')}`);
      }
      if (needToResyncIndexes.length > 0) {
        console.warn(`[HistoryStorage] need to resync later: ${needToResyncIndexes.sort().map((idx) => `@${idx}`).join(', ')}`);
      }

      // we should save unprocessed and incompleted records to restore them in case of library reload
      this.db.put(HISTORY_STATE_TABLE, [...unprocessedIndexes, ...needToResyncIndexes], 'fail_indexes');

      for (const oneIndex of processedIndexes) {
        if (!needToResyncIndexes.includes(oneIndex)) {
          // remove memo from the unparsed list if it shouldn't be resynced
          this.unparsedMemo.delete(oneIndex);
        }
      }

      this.syncIndex = Math.max(this.syncIndex, newSyncIndex);  // prevent sync index decreasing
      this.db.put(HISTORY_STATE_TABLE, this.syncIndex, 'sync_index');

      const timeMs = Date.now() - startTime;
      const remainStr = unprocessedIndexes.length > 0 ? ` (${unprocessedIndexes.length} memos remain unprocessed)` : '';
      const resyncStr = needToResyncIndexes.length > 0 ? ` (${needToResyncIndexes.length} memos will be re-synced)` : '';
      console.log(`[HistoryStorage] history has been synced up to index ${this.syncIndex}${remainStr}${resyncStr} in ${timeMs} msec (records: ${[...this.currentHistory.keys()].length})`);
    } else {
      // No any records (new or pending) => delete all pending history records
      for (const [index, record] of this.currentHistory.entries()) {
        if (record.state == HistoryRecordState.Pending) {
          this.currentHistory.delete(index);
        }
      }

      console.log(`[HistoryStorage] memo sync is not required: already up-to-date (on index ${this.syncIndex + 1})`);
    }

    // we also should take into account locally sent transactions which were not appeared
    // in optimistic or stable state received from the sequencer
    const commitments = [...this.currentHistory.values()].map((rec) => rec.commitment);
    this.pendingLocalHistory = [];
    for (const [txHash, records] of this.sentTxs.entries()) {
      for (const aRec of records) {
        if (commitments.includes(aRec.commitment) == false) {
          this.pendingLocalHistory.push(aRec);
        }
      }
    }
    

    return this.unparsedMemo.size == 0;
  }

  private async put(index: number, data: HistoryRecord): Promise<HistoryRecord> {
    await this.db.put(TX_TABLE, data, index);
    return data;
  }

  private async get(index: number): Promise<HistoryRecord | null> {
    const data = await this.db.get(TX_TABLE, index);
    return data;
  }

  private async getTxesDetails(
    memos: DecryptedMemo[]
  ): Promise<{
    details: PoolTxDetails[], // all fetched txes details
    fetched: number[],        // fetched tx's indexes (in Merkle tree)
    notFetched: number[],     // failed to fetch tx's indexes
    needResync: number[]}>    // indexes which are fetched incompletely
                              // (e.g. DD via fallback with existing subgraph)
  {
    const requestedIndexes = memos.map((aMemo) => aMemo.index);
    let fetchedTxs: PoolTxDetails[] = [];
    let fetchedIndexes: number[] = [];
    let fetchedIncompletely: number[] = [];
    if (this.subgraph) {
      // try to fetch txes from the sugraph (if available)
      fetchedTxs = await this.subgraph.getTxesDetails(requestedIndexes, this.state, this.network);
    }

    // subgraph-based magic (due to DD batch have no index)
    fetchedIndexes = fetchedTxs.map((aTx) => aTx.index);
    const fetchedTxHashes = fetchedTxs.map((aTx) => aTx.details.txHash);
    const fetchedIndexesByTxHashes = memos
      .filter((aMemo) => {
        return aMemo.txHash && fetchedTxHashes.includes(aMemo.txHash) && !fetchedIndexes.includes(aMemo.index);
      })
      .map((aMemo) => aMemo.index);
    fetchedIndexes = removeDuplicates([...fetchedIndexes, ...fetchedIndexesByTxHashes])

    // get unprocessed memos
    const unparsedMemos = memos.filter((aMemo) => !fetchedIndexes.includes(aMemo.index));

    // fetch from the RPC node unprocessed txs by subgraph
    if (this.subgraph && unparsedMemos.length > 0) {
      console.warn(`[HistoryStorage] Cannot fetch ${unparsedMemos.length} of ${memos.length} indexes from subgraph. Fallbacking to RPC node: ${unparsedMemos.map((aMemo) => aMemo.index).join(', ')}`);
    }
    const promises: Promise<PoolTxDetails | null>[] = [];
    for (let aMemo of unparsedMemos) {
      if (aMemo.txHash) {
        promises.push(this.network.getTxDetails(aMemo.index, aMemo.txHash, this.state));
      }
    }
    const resFromRpc = await Promise.all(promises);
    for (let aTx of resFromRpc) {
      if (aTx) {
        fetchedTxs.push(aTx);
        fetchedIndexes.push(aTx.index);
        if (aTx.poolTxType == PoolTxType.DirectDepositBatch && this.subgraph !== undefined) {
          fetchedIncompletely.push(aTx.index);
        }
      }
    }

    const notFetchedIndexes = requestedIndexes.filter((aIdx) => !fetchedIndexes.includes(aIdx));
    return {
      details: fetchedTxs,
      fetched: fetchedIndexes,
      notFetched: notFetchedIndexes,
      needResync: fetchedIncompletely,
    };
  }

  private async convertToHistory(
    memos: DecryptedMemo[],
    pending: boolean
  ): Promise<{
    records: HistoryRecordIdx[],
    succIdxs: number[],     // fetched successfully
    failIdxs: number[],     // the related txs are not presented in records 
    resyncIdxs: number[]}>  // the fetched txs which should be updated again for any reason
  {
    const result = await this.getTxesDetails(memos);
    const txesDetails = result.details;
    const fetched = result.fetched;
    const notFetched = result.notFetched;

    const allRecords: HistoryRecordIdx[] = [];
    for (let txDetails of txesDetails) {
      const memo = memos.find((aMemo) => aMemo.index == txDetails.index || aMemo.txHash == txDetails.details.txHash)
      if (memo) {
        if (txDetails.poolTxType == PoolTxType.Regular && txDetails.details instanceof RegularTxDetails) {
          // regular transaction
          const details = txDetails.details
          if (details.txType == RegularTxType.Deposit || details.txType == RegularTxType.BridgeDeposit) {
            const rec = await HistoryRecord.deposit(
              details.depositAddr ?? '',
              details.tokenAmount,
              details.feeAmount,
              details.timestamp,
              details.txHash,
              pending,
              BigInt(details.commitment),
            );
            allRecords.push(HistoryRecordIdx.create(rec, txDetails.index));
          } else if (details.txType == RegularTxType.Transfer) {
            // there are 2 cases: 
            if (memo.acc) {
              // 1. we initiated it => outcoming tx(s)
              const transfers = await Promise.all(memo.outNotes.map(async ({note}) => {
                const destAddr = await this.state.assembleAddress(note.d, note.p_d);
                return {to: destAddr, amount: BigInt(note.b)};
              }));

              if (transfers.length == 0) {
                const rec = await HistoryRecord.aggregateNotes(details.feeAmount, details.timestamp, details.txHash, pending);
                allRecords.push(HistoryRecordIdx.create(rec, memo.index));
              } else {
                const rec = await HistoryRecord.transferOut(
                  transfers,
                  details.feeAmount,
                  details.timestamp,
                  details.txHash,
                  pending,
                  async (addr) => this.state.isOwnAddress(addr),
                  BigInt(details.commitment),
                );
                allRecords.push(HistoryRecordIdx.create(rec, memo.index));
              }
            } else {
              // 2. somebody initiated it => incoming tx(s)
              const transfers = await Promise.all(memo.inNotes.map(async ({note}) => {
                const destAddr = await this.state.assembleAddress(note.d, note.p_d);
                return {to: destAddr, amount: BigInt(note.b)};
              }));

              const rec = await HistoryRecord.transferIn(transfers, BigInt(0), details.timestamp, details.txHash, pending);
              allRecords.push(HistoryRecordIdx.create(rec, memo.index));
            }
          } else if (details.txType == RegularTxType.Withdraw) {
            const rec = await HistoryRecord.withdraw(
              details.withdrawAddr ?? '', 
              -(details.tokenAmount + details.feeAmount),
              details.feeAmount,
              details.timestamp,
              details.txHash,
              pending,
              BigInt(details.commitment),
            );
            allRecords.push(HistoryRecordIdx.create(rec, memo.index));
          } else {
            throw new InternalError(`[HistoryStorage] Unknown transaction type ${details.txType}`)
          }

          if (!pending || (pending && details.isMined)) {
            // if tx is in pending state - remove it only on success
            this.removePendingTxByTxHash(details.txHash);
          }
        } else if (txDetails.poolTxType == PoolTxType.DirectDepositBatch && txDetails.details instanceof DDBatchTxDetails) {
          // transaction is DD batch on the pool
          // Direct Deposit tranaction
          const details = txDetails.details
          details.deposits.forEach(async (aDeposit, idx) => {
            const tokenMoving = {to: aDeposit.destination, amount: aDeposit.amount };
            const rec = await HistoryRecord.directDeposit(
              aDeposit.sender && aDeposit.sender != '' ? aDeposit.sender : aDeposit.fallback,
              aDeposit.destination,
              aDeposit.amount,
              aDeposit.fee,
              details.timestamp,
              details.txHash,
              pending,
              aDeposit.payment,
            );
            allRecords.push(HistoryRecordIdx.create(rec, memo.index + idx));
          });
        } else { 
          throw new InternalError(`Incorrect or unsupported transaction details`);
        }
      } else {
        throw new InternalError(`Could not find associated memo for txDetails (index: ${txDetails.index}, txHash: ${txDetails.details.txHash})`);
      }
    }

    // working with memos without fetched tx details
    for (let aUnprocessedIdx of notFetched) {
      const memo = memos.find((aMemo) => aMemo.index == aUnprocessedIdx);
      if (memo) {
        if (memo.txHash) {
          // Cannot retrieve transaction details (maybe it's not mined yet?)
          // Look for a transactions, initiated by the user and try to convert it to the HistoryRecord
          const records = this.sentTxs.get(memo.txHash);
          if (records !== undefined) {
            console.log(`[HistoryStorage] tx ${memo.txHash} isn't indexed yet, but we have ${records.length} associated history record(s)`);
            records.forEach((oneRecord, index) => {
              allRecords.push(HistoryRecordIdx.create(oneRecord, memo.index + index));
              if (!fetched.includes(memo.index)) fetched.push(memo.index);
              const x = notFetched.indexOf(memo.index);
              if (x >= 0) { notFetched.splice(x, 1); } 
            });
          } else {
            // we shouldn't panic here: will retry the next time
            console.warn(`[HistoryStorage] cannot fetch tx ${memo.txHash} and no local associated records`);
          }
        } else {
          throw new InternalError(`Cannot find txHash for memo at index ${memo.index}`);
        }
      } else {
        throw new InternalError(`Could not find associated memo for unprocessed index ${aUnprocessedIdx}`);
      }
    }

    return {records: allRecords, succIdxs: fetched, failIdxs: notFetched, resyncIdxs: result.needResync};
  }
}
