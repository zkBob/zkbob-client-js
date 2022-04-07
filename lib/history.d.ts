import { IDBPDatabase } from 'idb';
import { Account, Note } from 'libzeropool-rs-wasm-web';
export declare enum HistoryTransactionType {
    Deposit = 1,
    TransferIn = 2,
    TransferOut = 3,
    Withdrawal = 4
}
export interface DecryptedMemo {
    index: number;
    acc: Account | undefined;
    inNotes: {
        note: Note;
        index: number;
    }[];
    outNotes: {
        note: Note;
        index: number;
    }[];
}
export declare class HistoryRecord {
    type: HistoryTransactionType;
    timestamp: number;
    from: string;
    to: string;
    amount: bigint;
    fee: bigint;
    txHash: string;
    constructor(type: HistoryTransactionType, timestamp: number, from: string, to: string, amount: bigint, fee: bigint, txHash: string);
    toJson(): string;
}
export declare class HistoryRecordIdx {
    index: number;
    record: HistoryRecord;
    static create(record: HistoryRecord, index: number): HistoryRecordIdx;
}
export declare function convertToHistory(memo: DecryptedMemo, txHash: string, rpcUrl: string): Promise<HistoryRecordIdx[]>;
export declare class HistoryStorage {
    private db;
    constructor(db: IDBPDatabase);
    static init(db_id: string): Promise<HistoryStorage>;
    put(index: number, data: HistoryRecord): Promise<HistoryRecord>;
    get(index: number): Promise<HistoryRecord | null>;
}