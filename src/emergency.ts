import { IWithdrawData, SnarkProof } from "libzkbob-rs-wasm-web";
import { Pool } from "./config";
import { L1TxState, NetworkBackend, PreparedTransaction } from "./networks";
import { ZkBobState, ZERO_OPTIMISTIC_STATE } from "./state";
import { ZkBobSubgraph } from "./subgraph";
import { InternalError } from "./errors";
import { keccak256 } from "web3-utils";
import { addHexPrefix, bufToHex } from "./utils";

const WAIT_TX_TIMEOUT = 60;
const DEAD_SIGNATURE = BigInt('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead0000000000000000');
const DEAD_SIG_MASK  = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000');

export enum ForcedExitState {
  NotStarted = 0,
  CommittedWaitingSlot,
  CommittedReady,
  Completed,
  Outdated,
}

interface ForcedExit {
  nullifier: bigint;
  to: string;
  amount: bigint;
}

export interface ForcedExitRequest extends ForcedExit {
  operator: string;
  index: number;
  out_commit: bigint;
  tx_proof: SnarkProof;
}

export interface CommittedForcedExit extends ForcedExit {
  operator: string;
  exitStart: number;
  exitEnd: number;
  txHash: string;
}

export interface FinalizedForcedExit extends ForcedExit {
  cancelled: boolean; // false for successful forced exit, true for canceled one
  txHash: string;
}


export class ForcedExitProcessor {
  protected network: NetworkBackend;
  protected subgraph?: ZkBobSubgraph;
  protected state: ZkBobState;

  protected tokenAddress: string;
  protected poolAddress: string;

  
  constructor(pool: Pool, network: NetworkBackend, state: ZkBobState, subgraph?: ZkBobSubgraph) {
    this.network = network;
    this.subgraph = subgraph;
    this.state = state;
    this.tokenAddress = pool.tokenAddress;
    this.poolAddress = pool.poolAddress;
  }

  public async isForcedExitSupported(): Promise<boolean> {
    return this.network.isSupportForcedExit(this.poolAddress);
  }

  // state MUST be synced before at the top level
  public async isAccountDead(): Promise<boolean> {
    const nullifier = await this.getCurrentNullifier();
    const nullifierValue = await this.network.nullifierValue(this.poolAddress, BigInt(nullifier));

    return (nullifierValue & DEAD_SIG_MASK) == DEAD_SIGNATURE
  }

  // state MUST be synced before at the top level
  public async forcedExitState(): Promise<ForcedExitState> {
    const nullifier = await this.getCurrentNullifier();
    const nullifierValue = await this.network.nullifierValue(this.poolAddress, BigInt(nullifier));
    if (nullifierValue == 0n) {
    // the account is alive yet: check is forced exit procedure started
    const commitedForcedExit = await this.network.committedForcedExitHash(this.poolAddress, BigInt(nullifier));
    if (commitedForcedExit != 0n) {
        // the forced exit record exist on the pool for the current nullifier
        // check is it just committed or already cancelled
        const committed = await this.getActiveForcedExit();
        if (committed) {
          const curTs = Date.now() / 1000;
          if (curTs < committed.exitStart) {
            return ForcedExitState.CommittedWaitingSlot;
          } else if (curTs > committed.exitEnd) {
            return ForcedExitState.Outdated;
          }
          return ForcedExitState.CommittedReady;
        }
      }

      return ForcedExitState.NotStarted;
    } else {
      // nullifier value doesn't equal zero: checking if account was already killed
      if ((nullifierValue & DEAD_SIG_MASK) == DEAD_SIGNATURE) {
          return ForcedExitState.Completed;
      }

      throw new InternalError('The nullifier is not last for that account');
    }
  }

  public async getActiveForcedExit(): Promise<CommittedForcedExit | undefined> {
    const nullifier = BigInt(await this.getCurrentNullifier());
    const [isDead, isCommitted] = await Promise.all([
      this.isAccountDead(),
      this.network.committedForcedExitHash(this.poolAddress, nullifier).then((hash) => hash != 0n)
    ]);
    
    if (!isDead && isCommitted) {
      return this.network.committedForcedExit(this.poolAddress, nullifier)
    }

    return undefined;
  }

  public async getExecutedForcedExit(): Promise<FinalizedForcedExit | undefined> {
    if (await this.isAccountDead()) {
      return this.network.executedForcedExit(this.poolAddress, BigInt(await this.getCurrentNullifier()))
    }

    return undefined;
  }

  public async availableFundsToForcedExit(): Promise<bigint> {
    const accountBalance = await this.state.accountBalance();
    const notes = await this.state.usableNotes();
    const txNotesSum: bigint = notes.slice(0, 3).reduce((acc, cur) => acc + BigInt(cur[1].b), 0n);
    
    return accountBalance + txNotesSum;
  }

  public async requestForcedExit(
      executerAddress: string, // who will send emergency exit execute transaction
      toAddress: string,     // which address should receive funds
      sendTxCallback: (tx: PreparedTransaction) => Promise<string>,  // callback to send transaction 
      proofTxCallback: (pub: any, sec: any) => Promise<any>,
    ): Promise<CommittedForcedExit> {
      // getting available amount to emergency withdraw
      const requestedAmount = await this.availableFundsToForcedExit();;

      console.log(`Latest nullifier: ${await this.getCurrentNullifier()}`);

      // create regular withdraw tx
      const oneTx: IWithdrawData = {
          amount: requestedAmount.toString(),
          to: this.network.addressToBytes(toAddress),
          native_amount: '0',
          energy_amount: '0',
          proxy: this.network.addressToBytes(''),
          prover: this.network.addressToBytes(''),
          proxy_fee: '0',
          prover_fee: '0',
          data: [],
      };
      const oneTxData = await this.state.createWithdrawalOptimistic(oneTx, ZERO_OPTIMISTIC_STATE);

      // customize memo field in the public part (pool contract know nothing about real memo)
      const customMemo = addHexPrefix(bufToHex(oneTx.to));
      const customMemoHash = BigInt(keccak256(customMemo));
      const R = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
      oneTxData.public.memo = (customMemoHash % R).toString(10);

      // calculate transaction proof
      const txProof = await proofTxCallback(oneTxData.public, oneTxData.secret);

      // create an internal object to request
      const request: ForcedExitRequest = {
          nullifier: oneTxData.public.nullifier,
          operator: executerAddress,
          to: toAddress,
          amount: requestedAmount,
          index: oneTxData.parsed_delta.index,
          out_commit: oneTxData.public.out_commit,
          tx_proof: txProof.proof,
      }

      // getting raw transaction
      const commitTransaction = await this.network.createCommitForcedExitTx(this.poolAddress, request);
      // ...and bringing it back to the application to send it
      const txHash = await sendTxCallback(commitTransaction);

      // Assume tx was sent, try to figure out the result and retrieve a commited forced exit
      const waitingTimeout = Date.now() + WAIT_TX_TIMEOUT * 1000;
      do {
        const status = await this.network.getTransactionState(txHash);
        switch (status) {
          case L1TxState.MinedSuccess:
            const committed = await this.getActiveForcedExit();
            if (committed) {
              return committed;
            }
          case L1TxState.MinedFailed:
            const errReason = await this.network.getTxRevertReason(txHash);
            throw new InternalError(`Forced exit transaction was reverted with message: ${errReason ?? '<UNKNOWN>'}`);

          default: break;
        }
      } while (Date.now() < waitingTimeout);

      throw new InternalError('Unable to find forced exit commit transaction on the pool contract');
  }

  public async executeForcedExit(
    sendTxCallback: (tx: PreparedTransaction) => Promise<string>
  ): Promise<FinalizedForcedExit> {
    const state = await this.forcedExitState();
    if (state == ForcedExitState.CommittedReady) {
      return this.executeActiveForcedExit(false, sendTxCallback);
    } else {
      throw new InternalError('Invallid forced exit state to execute forced exit');
    }
  }

  public async cancelForcedExit(
    sendTxCallback: (tx: PreparedTransaction) => Promise<string>
  ): Promise<FinalizedForcedExit> {
    const state = await this.forcedExitState();
    if (state == ForcedExitState.Outdated) {
      return this.executeActiveForcedExit(true, sendTxCallback);
    } else {
      throw new InternalError('Invallid forced exit state to cancel forced exit');
    }
  }

  private async executeActiveForcedExit(
    cancel: boolean,
    sendTxCallback: (tx: PreparedTransaction) => Promise<string>
  ): Promise<FinalizedForcedExit> {
    const committed = await this.getActiveForcedExit();
    if (committed) {
      // getting raw transaction
      const transaction = cancel ? 
        await this.network.createCancelForcedExitTx(this.poolAddress, committed) :
        await this.network.createExecuteForcedExitTx(this.poolAddress, committed);
      // ...and bring it back to the application to send it
      const txHash = await sendTxCallback(transaction);

      // Assume tx was sent, try to figure out the result and retrieve a commited forced exit
      const waitingTimeout = Date.now() + WAIT_TX_TIMEOUT * 1000;
      do {
        const status = await this.network.getTransactionState(txHash);
        switch (status) {
          case L1TxState.MinedSuccess:
            return {
              nullifier: committed.nullifier,
              to: committed.to,
              amount: committed.amount,
              cancelled: cancel,
              txHash: txHash,
            };

          case L1TxState.MinedFailed:
            const errReason = await this.network.getTxRevertReason(txHash);
            throw new InternalError(`Forced exit ${cancel ? 'cancel' : 'execute'} transaction was reverted with message: ${errReason ?? '<UNKNOWN>'}`);

          default: break;
        }
      } while (Date.now() < waitingTimeout);

      throw new InternalError(`Unable to find forced exit ${cancel ? 'cancel' : 'execute'} transaction on the pool contract`);
    }

    throw new InternalError(`Cannot find active forced exit to ${cancel ? 'cancel' : 'execute'} (need to commit first)`)
  }

  private async getCurrentNullifier(): Promise<string> {
    return this.state.accountNullifier();
  }
    
}