import { expose } from 'comlink';
import { IDepositData, IDepositPermittableData, ITransferData, IWithdrawData,
          ParseTxsResult, ParseTxsColdStorageResult, StateUpdate,
          IndexedTx, TreeNode, SnarkProof, IAddressComponents,
          TxMemoChunk, TxInput, Account, Note,
        } from 'libzkbob-rs-wasm-web';
import { threads } from 'wasm-feature-detect';
import { SnarkParams } from './params';
import { Parameters } from './config';
import { InternalError } from './errors';

let txParams: { [name: string]: SnarkParams } = {};
let txParser: any;
let zpAccounts: { [accountId: string]: any } = {};

let wasm: any;

const obj = {
  async initWasm(
    params: Parameters,
    forcedMultithreading: boolean | undefined = undefined,
  ) {
    console.info('Initializing web worker...');
    
    // Safari doesn't support spawning Workers from inside other Workers yet.
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isMtSupported = await threads() && !isSafari;
    const isMt = forcedMultithreading ?? isMtSupported;  // forced MT param has a higher priority than supported one
    
    if (isMt) {
      console.log('Using multi-threaded version');
      wasm = await import('libzkbob-rs-wasm-web-mt');
      await wasm.default();
      await wasm.initThreadPool(navigator.hardwareConcurrency);
    } else {
      console.log('Using single-threaded version. Proof generation will be significantly slower.');
      wasm = await import('libzkbob-rs-wasm-web');
      await wasm.default()
    }


    // Initialize parameters
    for (const [name, par] of Object.entries(params)) {
      const snarkParams = new SnarkParams(par);
      // VK is always needed to transact, so initiate its loading right now
      snarkParams.getVk().catch((err) => {
        console.warn(`Unable to fetch tx verification key (don't worry, it will refetched when needed): ${err.message}`);
      });
      txParams[name] = snarkParams;
    }

    txParser = wasm.TxParser._new()

    console.info('Web worker init complete.');
  },

  async loadTxParams(paramsName: string, expectedHash?: string) {
    const params = txParams[paramsName];
    if (params === undefined) {
      throw new InternalError(`Cannot find snark parameters set \'${paramsName}\'`);
    }

    params.getParams(wasm, expectedHash);
  },

  async proveTx(paramsName: string, pub, sec) {
    const params = txParams[paramsName];
    if (params === undefined) {
      throw new InternalError(`Cannot find snark parameters set \'${paramsName}\'`);
    }

    console.debug('Web worker: proveTx');
    let snarkParams = await params.getParams(wasm);
    return wasm.Proof.tx(snarkParams, pub, sec);
  },

  async verifyTxProof(paramsName: string, inputs: string[], proof: SnarkProof): Promise<boolean> {
    const params = txParams[paramsName];
    if (params === undefined) {
      throw new InternalError(`Cannot find snark parameters set \'${paramsName}\'`);
    }

    const vk = await params.getVk();  // will throw error if VK fetch fail
    return wasm.Proof.verify(vk, inputs, proof);
  },

  async parseTxs(sk: Uint8Array, txs: IndexedTx[]): Promise<ParseTxsResult> {
    console.debug('Web worker: parseTxs');
    const result = txParser.parseTxs(sk, txs)
    sk.fill(0)
    return result;
  },

  async extractDecryptKeys(sk: Uint8Array, index: bigint, memo: Uint8Array): Promise<TxMemoChunk[]> {
    const result = txParser.extractDecryptKeys(sk, index, memo);
    sk.fill(0);
    return result;
  },

  async getTxInputs(accountId: string, index: bigint): Promise<TxInput> {
    return zpAccounts[accountId].getTxInputs(index);
  },

  async decryptAccount(symkey: Uint8Array, encrypted: Uint8Array): Promise<Account> {
    return txParser.symcipherDecryptAcc(symkey, encrypted);
  },

  async decryptNote(symkey: Uint8Array, encrypted: Uint8Array): Promise<Note> {
    return txParser.symcipherDecryptNote(symkey, encrypted);
  },

  async calcNullifier(accountId: string, account: Account, index: bigint): Promise<string> {
    return zpAccounts[accountId].calculateNullifier(account, index);
  },

  // accountId is a unique string depends on network, poolId and sk
  // The local db will be named with accountId
  async createAccount(accountId: string, sk: Uint8Array, poolId: number, isObsolete: boolean): Promise<void> {
    console.debug('Web worker: createAccount');
    try {
      const state = await wasm.UserState.init(accountId);
      zpAccounts[accountId] = new wasm.UserAccount(sk, poolId, isObsolete, state);
    } catch (e) {
      console.error(e);
    }
  },

  async totalBalance(accountId: string): Promise<string> {
    return zpAccounts[accountId].totalBalance();
  },

  async accountBalance(accountId: string): Promise<string> {
    return zpAccounts[accountId].accountBalance();
  },

  async noteBalance(accountId: string): Promise<string> {
    return zpAccounts[accountId].noteBalance();
  },

  async usableNotes(accountId: string): Promise<any[]> {
    return zpAccounts[accountId].getUsableNotes();
  },

  async rawState(accountId: string): Promise<any> {
    return zpAccounts[accountId].getWholeState();
  },

  async free(accountId: string): Promise<void> {
    return zpAccounts[accountId].free();
  },

  async createDepositPermittable(accountId: string, deposit: IDepositPermittableData): Promise<any> {
    return zpAccounts[accountId].createDepositPermittable(deposit);
  },

  async createTransferOptimistic(accountId: string, tx: ITransferData, optimisticState: any): Promise<any> {
    return zpAccounts[accountId].createTransferOptimistic(tx, optimisticState);
  },

  async createWithdrawalOptimistic(accountId: string, tx: IWithdrawData, optimisticState: any): Promise<any> {
    return zpAccounts[accountId].createWithdrawalOptimistic(tx, optimisticState);
  },

  async createDeposit(accountId: string, deposit: IDepositData): Promise<any> {
    return zpAccounts[accountId].createDeposit(deposit);
  },

  async createTransfer(accountId: string, transfer: ITransferData): Promise<any> {
    return zpAccounts[accountId].createTransfer(transfer);
  },

  async nextTreeIndex(accountId: string): Promise<bigint> {
    return zpAccounts[accountId].nextTreeIndex();
  },

  async firstTreeIndex(accountId: string): Promise<bigint | undefined> {
    return zpAccounts[accountId].firstTreeIndex();
  },

  async getRoot(accountId: string): Promise<string> {
    return zpAccounts[accountId].getRoot();
  },

  async getRootAt(accountId: string, index: bigint): Promise<string> {
    return zpAccounts[accountId].getRootAt(index);
  },

  async getLeftSiblings(accountId: string, index: bigint): Promise<TreeNode[]> {
    return zpAccounts[accountId].getLeftSiblings(index);
  },

  async rollbackState(accountId: string, index: bigint): Promise<bigint> {
    return zpAccounts[accountId].rollbackState(index);
  },

  async wipeState(accountId: string): Promise<void> {
    return zpAccounts[accountId].wipeState();
  },

  async getTreeLastStableIndex(accountId: string): Promise<bigint> {
    return zpAccounts[accountId].treeGetStableIndex();
  },

  async setTreeLastStableIndex(accountId: string, index: bigint): Promise<void> {
    return zpAccounts[accountId].treeSetStableIndex(index);
  },

  async updateState(accountId: string, stateUpdate: StateUpdate, siblings?: TreeNode[]): Promise<void> {
    console.debug('Web worker: updateState');
    return zpAccounts[accountId].updateState(stateUpdate, siblings);
  },

  async updateStateColdStorage(accountId: string, bulks: Uint8Array[], indexFrom?: bigint, indexTo?: bigint): Promise<ParseTxsColdStorageResult> {
    console.debug('Web worker: updateStateColdStorage');
    return zpAccounts[accountId].updateStateColdStorage(bulks, indexFrom, indexTo);
  },

  async generateAddress(accountId: string): Promise<string> {
    return zpAccounts[accountId].generateAddress();
  },

  async generateUniversalAddress(accountId: string): Promise<string> {
    return zpAccounts[accountId].generateUniversalAddress();
  },

  async generateAddressForSeed(accountId: string, seed: Uint8Array): Promise<string> {
    return zpAccounts[accountId].generateAddressForSeed(seed);
  },

  async generateUniversalAddressForSeed(accountId: string, seed: Uint8Array): Promise<string> {
    return zpAccounts[accountId].generateUniversalAddressForSeed(seed);
  },

  async verifyShieldedAddress(accountId: string, shieldedAddress: string): Promise<boolean> {
    return zpAccounts[accountId].validateAddress(shieldedAddress);
  },

  async verifyUniversalShieldedAddress(accountId: string, shieldedAddress: string): Promise<boolean> {
    return zpAccounts[accountId].validateUniversalAddress(shieldedAddress);
  },

  async isOwnAddress(accountId: string, shieldedAddress: string): Promise<boolean> {
    return zpAccounts[accountId].isOwnAddress(shieldedAddress);
  },

  async assembleAddress(accountId: string, d: string, p_d: string): Promise<string> {
    return zpAccounts[accountId].assembleAddress(d, p_d);
  },

  async assembleUniversalAddress(accountId: string, d: string, p_d: string): Promise<string> {
    return zpAccounts[accountId].assembleUniversalAddress(d, p_d);
  },

  async convertAddressToChainSpecific(accountId: string, oldAddress: string): Promise<string> {
    return zpAccounts[accountId].convertAddressToChainSpecific(oldAddress);
  },

  async parseAddress(accountId: string, shieldedAddress: string, poolId?: number): Promise<IAddressComponents> {
    return zpAccounts[accountId].parseAddress(shieldedAddress, poolId);
  },

  async accountNullifier(accountId: string): Promise<string> {
    return zpAccounts[accountId].accountNullifier();
  }

};

expose(obj);
