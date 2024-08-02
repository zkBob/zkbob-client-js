import PromiseThrottle from 'promise-throttle';
import { getBuiltGraphSDK } from "../.graphclient";
import { hostedServiceDefaultURL } from "./resolvers";
import { ZkBobState } from "../state";
import { InternalError } from "../errors";
import { DDBatchTxDetails, DirectDeposit, DirectDepositState,
         PoolTxDetails, PoolTxMinimal, PoolTxType, RegularTxDetails, RegularTxType, TxState
        } from "../tx";
import { decodeEvmCalldata } from '../networks/evm/calldata';
import { DepositSignerFactory } from '../signers/signer-factory';
import { NetworkBackend } from '../networks';
import { DepositType } from '../config';
import { DepositData } from '../signers/abstract-signer';
import { addHexPrefix, toTwosComplementHex, truncateHexPrefix } from '../utils';
import { CONSTANTS } from '../constants';

const SUBGRAPH_REQUESTS_PER_SECOND = 10;
const SUBGRAPH_MAX_ITEMS_IN_RESPONSE = 100;
const SUBGRAPH_ID_INDEX_DELTA = 0;


export class ZkBobSubgraph {
    protected subgraph: string; // a name on the Hosted Service or full URL
    protected sdk;
    throttle: PromiseThrottle;

    constructor(subgraphNameOrUrl: string) {
        this.subgraph = subgraphNameOrUrl;

        this.sdk = getBuiltGraphSDK({
            subgraphEndpoint: this.subgraphEndpoint(),
        });

        this.throttle = new PromiseThrottle({
            requestsPerSecond: SUBGRAPH_REQUESTS_PER_SECOND,
            promiseImplementation: Promise,
        });
    }

    protected subgraphEndpoint(): string | undefined {
        if (this.subgraph) {
            if (this.subgraph.indexOf('/') == -1) {
                return `${hostedServiceDefaultURL}${this.subgraph}`;
            }
        }

        return this.subgraph;
    }

    protected async parseSubraphDD(subraphDD: any, state: ZkBobState): Promise<DirectDeposit> {
        let ddState: DirectDepositState;
        if (subraphDD.pending) {
            ddState = DirectDepositState.Queued;
        } else if (subraphDD.refunded) {
            ddState = DirectDepositState.Refunded;
        } else if (subraphDD.completed) {
            ddState = DirectDepositState.Deposited;
        } else {
            throw new InternalError(`Incorrect state for direct deposit ${subraphDD.id}`);
        }

        const d = BigInt(subraphDD.zkAddress_diversifier);
        const p_d = BigInt(subraphDD.zkAddress_pk);
        const zkAddress = await state.assembleAddress(d.toString(), p_d.toString());

        const appDD: DirectDeposit =  {
            id: BigInt(subraphDD.id),
            state: ddState,
            amount: BigInt(subraphDD.deposit),
            destination: zkAddress,
            fee: BigInt(subraphDD.fee),
            fallback: subraphDD.fallbackUser,
            sender: subraphDD.sender,
            queueTimestamp: Number(subraphDD.tsInit),
            queueTxHash: subraphDD.txInit,
            timestamp: subraphDD.tsClosed ? Number(subraphDD.tsClosed) : undefined,
            txHash: subraphDD.txClosed,
            payment: subraphDD.payment,
        };

        return appDD;
    }

    public async fetchDirectDeposit(id: bigint, state: ZkBobState): Promise<DirectDeposit | undefined> {
        const requestedDD = await this.throttle.add(() => {
            return this.sdk.DirectDepositById({ 'id': id }, {
                subgraphEndpoint: this.subgraphEndpoint(),
            })
            .then((data) => data.directDeposit)
            .catch((err) => {
                console.warn(`[Subgraph]: Cannot fetch DD with id ${id} (${err.message})`);
                return null;
            });
        });

        if (requestedDD) {
            return this.parseSubraphDD(requestedDD, state);   
        }

        return undefined;
    }

    public async pendingDirectDeposits(state: ZkBobState): Promise<DirectDeposit[]> {
        const allPendingDDs = await this.throttle.add(() => {
            return this.sdk.PendingDirectDeposits({}, {
                subgraphEndpoint: this.subgraphEndpoint(),
            }).then((data) => data.directDeposits)
            .catch((err) => {
                console.warn(`[Subgraph]: Cannot fetch pending DDs (${err.message})`);
                return null;
            });
        });

        if (Array.isArray(allPendingDDs)) {
            const myPendingDDs = (await Promise.all(allPendingDDs.map(async (subgraphDD) => {
                const dd = await this.parseSubraphDD(subgraphDD, state);
                const isOwn = await state.isOwnAddress(dd.destination);

                return {dd, isOwn};
            })))
            .filter((dd) => dd.isOwn)
            .map((myDD) => myDD.dd);

            return myPendingDDs;
        } else {
            throw new InternalError(`Unexpected response from the DD subgraph: ${allPendingDDs}`);
        }
    }

    // NetworkBackend needed only for approve-deposit sender address recovering
    public async getTxesDetails(indexes: number[], state: ZkBobState, network: NetworkBackend): Promise<PoolTxDetails[]> {
        const chunksPromises: Promise<any[]>[] = [];
        for (let i = 0; i < indexes.length; i += SUBGRAPH_MAX_ITEMS_IN_RESPONSE) {
            const chunk = indexes.slice(i, i + SUBGRAPH_MAX_ITEMS_IN_RESPONSE);
            chunksPromises.push(this.throttle.add(() => {
                const preparedIdxs = chunk.map((aIdx) => String(aIdx + SUBGRAPH_ID_INDEX_DELTA));
                return this.sdk.PoolTxesByIndexes({ 'index_in': preparedIdxs, 'first': SUBGRAPH_MAX_ITEMS_IN_RESPONSE }, {
                    subgraphEndpoint: this.subgraphEndpoint(),
                })
                .then((data) => data.poolTxes)
                .catch((err) => {
                    console.warn(`[Subgraph]: Cannot fetch txes @ [${preparedIdxs.join(', ')}] (${err.message})`);
                    return [];
                });
            }));
        }

        const txs: any[] = [];
        const chunksReady = await Promise.all(chunksPromises);
        chunksReady.forEach((aChunk) => {
            txs.push(...aChunk);
        })

        return Promise.all(txs.map(async (tx) => {
            if (tx.type != 100) {
                // regular pool transaction
                const txDetails = new RegularTxDetails();
                txDetails.txHash = tx.tx;
                txDetails.isMined = true;   // subgraph returns only mined txs
                txDetails.timestamp = Number(tx.ts);
                txDetails.feeAmount = BigInt(tx.operation.fee);
                //toTwosComplementHex(BigInt(txData.public.nullifier), 32)
                txDetails.nullifier = '0x' + toTwosComplementHex(BigInt((tx.operation.nullifier)), 32);
                txDetails.commitment = '0x' + toTwosComplementHex(BigInt((tx.zk.out_commit)), 32);
                txDetails.ciphertext = tx.message
                if (tx.type == 0) {
                    // deposit via approve
                    txDetails.txType = RegularTxType.Deposit;
                    txDetails.tokenAmount = BigInt(tx.operation.token_amount)
                    // Due to the subgraph doesn't have ecrecover ability we should recover depositor address manually
                    // Please keep in mind non-evm networks possible incompatibilities
                    if (tx.operation.pooltx.calldata) {
                        const shieldedTx = decodeEvmCalldata(tx.operation.pooltx.calldata)
                        if (shieldedTx.extra && shieldedTx.extra.length >= 128) {
                            const approveSigner = DepositSignerFactory.createSigner(network, DepositType.Approve);
                            const depositData: DepositData = {
                                // this stub needed to recover approve signature (just a nullifier make sense here)
                                tokenAddress: '', owner: '', spender: '', amount: 0n, deadline: 0n, nullifier: txDetails.nullifier
                            }
                            const signature = shieldedTx.extra.slice(0, 128);
                            txDetails.depositAddr = await approveSigner.recoverAddress(depositData, signature);
                        } else {
                            // incorrect signature
                            console.warn(`Cannot recover depositor address from the signature for tx ${tx.tx}`);
                        }
                    }
                } else if (tx.type == 1) {
                    // transfer
                    txDetails.txType = RegularTxType.Transfer;
                    txDetails.tokenAmount = -txDetails.feeAmount;
                } else if (tx.type == 2) {
                    // withdrawal
                    txDetails.txType = RegularTxType.Withdraw;
                    txDetails.tokenAmount = BigInt(tx.operation.token_amount);
                    txDetails.withdrawAddr = tx.operation.receiver;
                } else if (tx.type == 3) {
                    // deposit via permit
                    txDetails.txType = RegularTxType.BridgeDeposit;
                    txDetails.tokenAmount = BigInt(tx.operation.token_amount);
                    txDetails.depositAddr = tx.operation.permit_holder;
                } else {
                    throw new InternalError(`Incorrect tx type from subgraph (${tx.type})`)
                }

                return { poolTxType: PoolTxType.Regular, details: txDetails, index: Number(tx.index) - SUBGRAPH_ID_INDEX_DELTA };
            } else {
                // direct deposit batch
                const txDetails = new DDBatchTxDetails();
                txDetails.txHash = tx.tx;
                txDetails.isMined = true;   // subgraph returns only mined txs
                txDetails.timestamp = Number(tx.ts);
                
                const DDs = tx.operation.delegated_deposits
                if (Array.isArray(DDs)) {
                    txDetails.deposits = (await Promise.all(DDs.map(async (subgraphDD) => {
                            const dd = await this.parseSubraphDD(subgraphDD, state);
                            const isOwn = await state.isOwnAddress(dd.destination);

                            return {dd, isOwn};
                        })))
                        .filter((dd) => dd.isOwn)   // grab the own DDs only
                        .map((myDD) => myDD.dd);
                } else {
                    throw new InternalError(`Incorrect tx type from subgraph (${tx.type})`)
                }

                return { poolTxType: PoolTxType.DirectDepositBatch, details: txDetails, index: Number(tx.index) - SUBGRAPH_ID_INDEX_DELTA };
            }
        }));
    }

    public async getTxesMinimal(fromIndex: number, count: number): Promise<PoolTxMinimal[]> {
        const chunksPromises: Promise<any[]>[] = [];
        const OUTPLUSONE = CONSTANTS.OUT + 1; // number of leaves (account + notes) in a transaction
        for (let i = fromIndex; i < fromIndex + count * OUTPLUSONE; i += (SUBGRAPH_MAX_ITEMS_IN_RESPONSE * OUTPLUSONE)) {
            chunksPromises.push(this.throttle.add(() => {
                return this.sdk.PoolTxesFromIndex({ 'index_gte': i, 'first': SUBGRAPH_MAX_ITEMS_IN_RESPONSE }, {
                    subgraphEndpoint: this.subgraphEndpoint(),
                })
                .then((data) => data.poolTxes)
                .catch((err) => {
                    console.warn(`[Subgraph]: Cannot fetch txes from index ${i} (${err.message})`);
                    throw new InternalError(`Subgraph tx fetching error: ${err.message}`);
                });
            }));
        }

        const txs: any[] = [];
        const chunksReady = await Promise.all(chunksPromises);
        chunksReady.forEach((aChunk) => {
            txs.push(...aChunk);
        })

        return Promise.all(txs.map(async (tx) => {
            return {
                index: Number(tx.index),
                commitment: BigInt(tx.zk.out_commit).toString(16).padStart(64, '0'),  // should be without hex prefix
                txHash: tx.tx,  // blockchain transaction hash
                memo: truncateHexPrefix(tx.message),   // starting from items_num, without hex prefix
                state: TxState.Finalized,  // subgraph index only mined transactions
              }
        }));
    }
}