import { L1TxState, NetworkBackend, PreparedTransaction } from '..';
import { InternalError, TxType } from '../../index';
import { DDBatchTxDetails, DirectDeposit, DirectDepositState, PoolTxDetails, PoolTxType, RegularTxDetails, RegularTxType, TxCalldataVersion } from '../../tx';
import tokenAbi from './abi/usdt-abi.json';
import { ddContractABI as ddAbi, poolContractABI as poolAbi, accountingABI} from '../evm/evm-abi';
import { addHexPrefix, bufToHex, hexToBuf, toTwosComplementHex, truncateHexPrefix } from '../../utils';
import { CalldataInfo, decodeEvmCalldata, getCiphertext, parseTransactCalldata } from '../evm/calldata';
import { hexToBytes } from 'web3-utils';
import { PoolSelector } from '../evm';
import { MultiRpcManager, RpcManagerDelegate } from '../rpcman';
import { ZkBobState } from '../../state';
import { CommittedForcedExit, FinalizedForcedExit, ForcedExitRequest } from '../../emergency';

const TronWeb = require('tronweb')
const bs58 = require('bs58')

const RETRY_COUNT = 5;
const DEFAULT_ENERGY_FEE = 420;
const DEFAULT_FEE_LIMIT = 100_000_000;
const ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

export class TronNetwork extends MultiRpcManager implements NetworkBackend, RpcManagerDelegate {
    protected tronWeb;
    protected address: string;
    // We need to cache a contract object for the each token address separately
    private tokenContracts = new Map<string, object>();  // tokenAddress -> contact object
    private poolContracts = new Map<string, object>();  // tokenAddress -> contact object
    private ddContracts = new Map<string, object>();  // tokenAddress -> contact object
    private accountingContracts = new Map<string, object>();  // tokenAddress -> contact object

    // blockchain long-lived cached parameters
    private chainId: number | undefined = undefined;
    private energyFee: number | undefined = undefined;
    private tokenSymbols = new Map<string, string>();  // tokenAddress -> token_symbol
    private tokenDecimals = new Map<string, number>();  // tokenAddress -> decimals
    private tokenSellerAddresses = new Map<string, string>();   // poolContractAddress -> tokenSellerContractAddress
    private ddContractAddresses = new Map<string, string>();    // poolAddress -> ddQueueAddress
    private accountingAddresses = new Map<string, string>();    // poolAddress -> accountingAddress
    private supportedMethods = new Map<string, boolean>(); // contractAddress+method => isSupport

    // ------------------------=========< Lifecycle >=========------------------------
    // | Init, enabling and disabling backend                                        |
    // -------------------------------------------------------------------------------
    constructor(rpcUrls: string[], enabled: boolean = true) {
        super(rpcUrls.map((aUrl) => aUrl.endsWith('/') ? aUrl : aUrl += '/' ));
        super.delegate = this;

        if (enabled) {
            this.setEnabled(true);
        }
    }

    private activeTronweb(): any {
        if (!this.tronWeb) {
            throw new InternalError(`TronNetwork: Cannot interact in the disabled mode`);
        }

        return this.tronWeb;
    }

    public isEnabled(): boolean {
        return this.tronWeb !== undefined;
    }

    public setEnabled(enabled: boolean) {
        if (enabled) {
            if (!this.isEnabled()) {
                this.tronWeb = new TronWeb({
                    fullHost: this.curRpcUrl(),
                    privateKey: '01',
                });
            }
        } else {
            this.tronWeb = undefined;
            this.tokenContracts.clear();
            this.poolContracts.clear();
            this.ddContracts.clear();
            this.accountingContracts.clear();
        }
    }

    protected async getTokenContract(tokenAddress: string): Promise<any> {
        let contract = this.tokenContracts.get(tokenAddress);
        if (!contract) {
            contract = await this.activeTronweb().contract(tokenAbi, tokenAddress);
            if (contract) {
                this.tokenContracts.set(tokenAddress, contract);
            } else {
                throw new Error(`Cannot initialize a contact object for the token ${tokenAddress}`);
            }
        }

        return contract;
    }

    protected async getPoolContract(poolAddress: string): Promise<any> {
        let contract = this.poolContracts.get(poolAddress);
        if (!contract) {
            contract = await this.activeTronweb().contract(poolAbi, poolAddress);
            if (contract) {
                this.poolContracts.set(poolAddress, contract);
            } else {
                throw new Error(`Cannot initialize a contact object for the pool ${poolAddress}`);
            }
        }

        return contract;
    }

    protected async getDdContract(ddQueueAddress: string): Promise<any> {
        let contract = this.ddContracts.get(ddQueueAddress);
        if (!contract) {
            contract = await this.activeTronweb().contract(ddAbi, ddQueueAddress);
            if (contract) {
                this.ddContracts.set(ddQueueAddress, contract);
            } else {
                throw new Error(`Cannot initialize a contact object for the DD queue ${ddQueueAddress}`);
            }
        }

        return contract;
    }

    protected async getAccountingContract(accountingAddress: string): Promise<any> {
        let contract = this.accountingContracts.get(accountingAddress);
        if (!contract) {
            contract = await this.activeTronweb().contract(accountingABI, accountingAddress);
            if (contract) {
                this.ddContracts.set(accountingAddress, contract);
            } else {
                throw new Error(`Cannot initialize a contact object for the accounting ${accountingAddress}`);
            }
        }

        return contract;
    }

    private contractCallRetry(contract: any, method: string, args: any[] = []): Promise<any> {
        return this.commonRpcRetry(async () => {
                return await contract[method](...args).call()
            },
            `[TronNetwork] Contract call (${method}) error`,
            RETRY_COUNT,
        );
    }

    private async isMethodSupportedByContract(contractAddress: string, methodName: string): Promise<boolean> {
        const mapKey = contractAddress + methodName;
        let isSupport = this.supportedMethods.get(mapKey);
        if (isSupport === undefined) {
            const contract = await this.commonRpcRetry(() => {
                return this.tronWeb.trx.getContract(contractAddress);
            }, 'Unable to retrieve smart contract object', RETRY_COUNT);
            const methods = contract.abi.entrys;
            if (Array.isArray(methods)) {
                isSupport = methods.find((val) => val.name == methodName) !== undefined;
                this.supportedMethods.set(mapKey, isSupport);
            } else {
                isSupport = false;
            }
        }

        return isSupport;
    }
    
    // -----------------=========< Token-Related Routiness >=========-----------------
    // | Getting balance, allowance, nonce etc                                       |
    // -------------------------------------------------------------------------------

    public async getTokenName(tokenAddress: string): Promise<string> {
        let res = this.tokenSymbols.get(tokenAddress);
        if (!res) {
            try {
                const token = await this.getTokenContract(tokenAddress);
                res = await this.contractCallRetry(token, 'symbol');
                if (typeof res === 'string') {
                    this.tokenSymbols.set(tokenAddress, res);
                } else {
                    throw new Error(`returned token symbol has ${typeof res} type (string expected)`);
                }
            } catch (err) {
                console.warn(`Cannot fetch symbol for the token ${tokenAddress}. Reason: ${err.message}`);
            }
        }
        
        return res ?? '';
    }

    public async getTokenDecimals(tokenAddress: string): Promise<number> {
        let res = this.tokenDecimals.get(tokenAddress);
        if (!res) {
            const token = await this.getTokenContract(tokenAddress);
            res = Number(await this.contractCallRetry(token, 'decimals'));
            this.tokenDecimals.set(tokenAddress, res);
        }
        
        return res;
    }

    public async getDomainSeparator(tokenAddress: string): Promise<string> {
        throw new InternalError(`Domain separator is currently unsupported for TRC20 tokens`)
    }
    
    public async getTokenNonce(tokenAddress: string, address: string): Promise<number> {
        throw new InternalError(`Token nonce is currently unsupported for TRC20 tokens`)
    }

    public async getTokenBalance(tokenAddress: string, address: string): Promise<bigint> {
        const token = await this.getTokenContract(tokenAddress);
        let result = await this.contractCallRetry(token, 'balanceOf', [address]);

        return BigInt(result);
    }

    public async allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
        const token = await this.getTokenContract(tokenAddress);
        let result = await this.contractCallRetry(token, 'allowance', [owner, spender]);

        return BigInt(result);
    }

    public async permit2NonceBitmap(permit2Address: string, owner: string, wordPos: bigint): Promise<bigint> {
        throw new InternalError(`Nonce bitmaps is currently unsupported for TRC20 tokens`)
    }

    public async erc3009AuthState(tokenAddress: string, authorizer: string, nonce: bigint): Promise<bigint> {
        throw new InternalError(`Authorisation state is currently unsupported for TRC20 tokens`)
    }

    public async approveTokens(
        tokenAddress: string,
        privateKey: string,
        _holder: string,
        spender: string,
        amount: bigint,
        _gasFactor?: number
    ): Promise<string> {
        const selector = 'approve(address,uint256)';
        const parameters = [{type: 'address', value: spender}, {type: 'uint256', value: amount}]
        
        return this.verifyAndSendTx(tokenAddress, selector, parameters, privateKey)
    }

    public async isSupportNonce(tokenAddress: string): Promise<boolean> {
        return this.isMethodSupportedByContract(tokenAddress, 'nonces');
    }

    // ---------------------=========< Pool Interaction >=========--------------------
    // | Getting common info: pool ID, denominator, limits etc                       |
    // -------------------------------------------------------------------------------

    public async getPoolId(poolAddress: string): Promise<number> {
        const pool = await this.getPoolContract(poolAddress);
        let result = await this.contractCallRetry(pool, 'pool_id');

        return Number(result);
    }

    public async getDenominator(poolAddress: string): Promise<bigint> {
        const pool = await this.getPoolContract(poolAddress);
        let result = await this.contractCallRetry(pool, 'denominator');

        return BigInt(result);
    }

    public async poolState(poolAddress: string, index?: bigint): Promise<{index: bigint, root: bigint}> {
        const pool = await this.getPoolContract(poolAddress);
        let idx;
        if (index === undefined) {
            idx = await this.contractCallRetry(pool, 'pool_index');
        } else {
            idx = index.toString();
        }
        let root = BigInt(await this.contractCallRetry(pool, 'roots', [idx]));
        if (root == 0n) {
            // it's seems the RPC node got behind the actual blockchain state
            // let's try to find the best one and retry root request
            const switched = await this.switchToTheBestRPC();
            if (switched) {
                root = BigInt(await this.contractCallRetry(pool, 'roots', [idx]));
            }
            if (root == 0n) {
                console.warn(`[TronNetwork] cannot retrieve root at index ${idx} (is it exist?)`);
            }
        }

        return {index: BigInt(idx), root};
    }

    public async poolLimits(poolAddress: string, address: string | undefined): Promise<any> {
        let contract: any;
        if (await this.isMethodSupportedByContract(poolAddress, 'accounting')) {
            // Current contract deployments (getLimitsFor implemented in the separated ZkBobAccounting contract)
            let accountingAddr = this.accountingAddresses.get(poolAddress);
            if (!accountingAddr) {
                const pool = await this.getPoolContract(poolAddress);
                const rawAddr = await this.contractCallRetry(pool, 'accounting');
                accountingAddr = TronWeb.address.fromHex(rawAddr);
                if (accountingAddr) {
                    this.accountingAddresses.set(poolAddress, accountingAddr);
                } else {
                    throw new InternalError(`Cannot fetch accounting contract address`);
                }
            }

            contract = await this.getAccountingContract(accountingAddr);
        } else {
            // Fallback for the old deployments (getLimitsFor implemented in pool contract)
            contract = await this.getPoolContract(poolAddress);
        }

        return await this.contractCallRetry(contract, 'getLimitsFor', [address ?? ZERO_ADDRESS]);
    }

    public async isSupportForcedExit(poolAddress: string): Promise<boolean> {
        return this.isMethodSupportedByContract(poolAddress, 'committedForcedExits');
    }

    public async nullifierValue(poolAddress: string, nullifier: bigint): Promise<bigint> {
        const pool = await this.getPoolContract(poolAddress);
        const res = await this.contractCallRetry(pool, 'nullifiers', [nullifier.toString()]);

        return BigInt(res);
    }

    public async committedForcedExitHash(poolAddress: string, nullifier: bigint): Promise<bigint> {
        const pool = await this.getPoolContract(poolAddress);
        const res = await this.contractCallRetry(pool, 'committedForcedExits', [nullifier.toString()]);

        return BigInt(res);
    }

    private async prepareTransaction(
        contractAddress: string,
        selector: string,   // name(arg1_type,arg2_type,...)
        parameters: {type: string, value: any}[],
        nativeAmount: bigint = 0n,  // sun
        feeLimit: number = DEFAULT_FEE_LIMIT,   // how many user's trx can be converted to energy
    ): Promise<PreparedTransaction> {
        const tx = await this.activeTronweb().transactionBuilder.triggerSmartContract(contractAddress, selector, { feeLimit }, parameters);
        const contract = tx?.transaction?.raw_data?.contract;
        let txData: any | undefined;
        if (Array.isArray(contract) && contract.length > 0) {
            txData = truncateHexPrefix(contract[0].parameter?.value?.data);
        }

        if (typeof txData !== 'string' || txData.length < 8) {
            throw new InternalError(`Unable to extract tx (${selector.split('(')[0]}) calldata`);
        }

        return {
            to: contractAddress,
            amount: nativeAmount,
            data: txData.slice(8),  // skip selector from the calldata
            selector,
        };
    }

    public async createCommitForcedExitTx(poolAddress: string, forcedExit: ForcedExitRequest): Promise<PreparedTransaction> {
        const selector = 'commitForcedExit(address,address,uint256,uint256,uint256,uint256,uint256[8])';
        const parameters = [
            {type: 'address', value: forcedExit.operator},
            {type: 'address', value: forcedExit.to},
            {type: 'uint256', value: forcedExit.amount.toString()},
            {type: 'uint256', value: forcedExit.index},
            {type: 'uint256', value: forcedExit.nullifier.toString()},
            {type: 'uint256', value: forcedExit.out_commit.toString()},
            {type: 'uint256[8]', value: [forcedExit.tx_proof.a,
                                         forcedExit.tx_proof.b,
                                         forcedExit.tx_proof.c,
                                        ].flat(2)},
        ];
        
        return this.prepareTransaction(poolAddress, selector, parameters);
    }

    public async committedForcedExit(poolAddress: string, nullifier: bigint): Promise<CommittedForcedExit | undefined> {
        throw new InternalError('unimplemented');
    }

    public async executedForcedExit(poolAddress: string, nullifier: bigint): Promise<FinalizedForcedExit | undefined> {
        throw new InternalError('unimplemented');
    }

    public async createExecuteForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction> {
        const selector = 'executeForcedExit(uint256,address,address,uint256,uint256,uint256,bool)';
        const parameters = [
            {type: 'uint256', value: forcedExit.nullifier.toString()},
            {type: 'address', value: forcedExit.operator},
            {type: 'address', value: forcedExit.to},
            {type: 'uint256', value: forcedExit.amount.toString()},
            {type: 'uint256', value: forcedExit.exitStart},
            {type: 'uint256', value: forcedExit.exitEnd},
            {type: 'bool',    value: 0},
        ];
        
        return this.prepareTransaction(poolAddress, selector, parameters);
    }

    public async createCancelForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction> {
        const selector = 'executeForcedExit(uint256,address,address,uint256,uint256,uint256,bool)';
        const parameters = [
            {type: 'uint256', value: forcedExit.nullifier.toString()},
            {type: 'address', value: forcedExit.operator},
            {type: 'address', value: forcedExit.to},
            {type: 'uint256', value: forcedExit.amount.toString()},
            {type: 'uint256', value: forcedExit.exitStart},
            {type: 'uint256', value: forcedExit.exitEnd},
            {type: 'bool',    value: 1},
        ];

        return this.prepareTransaction(poolAddress, selector, parameters);
    }

    public async getTokenSellerContract(poolAddress: string): Promise<string> {
        let tokenSellerAddr = this.tokenSellerAddresses.get(poolAddress);
        if (!tokenSellerAddr) {
            const pool = await this.getPoolContract(poolAddress);
            const rawAddr = await this.contractCallRetry(pool, 'tokenSeller');
            tokenSellerAddr = TronWeb.address.fromHex(rawAddr);
            if (tokenSellerAddr) {
                this.tokenSellerAddresses.set(poolAddress, tokenSellerAddr);
            } else {
                throw new InternalError(`Cannot fetch token seller contract address`);
            }
        }

        return tokenSellerAddr;
    }


    // ---------------------=========< Direct Deposits >=========---------------------
    // | Sending DD and fetching info                                                |
    // -------------------------------------------------------------------------------

    public async getDirectDepositQueueContract(poolAddress: string): Promise<string> {
        let ddContractAddr = this.ddContractAddresses.get(poolAddress);
        if (!ddContractAddr) {
            const pool = await this.getPoolContract(poolAddress);
            const rawAddr = await this.contractCallRetry(pool, 'direct_deposit_queue');
            ddContractAddr = TronWeb.address.fromHex(rawAddr);
            if (ddContractAddr) {
                this.ddContractAddresses.set(poolAddress, ddContractAddr);
            } else {
                throw new InternalError(`Cannot fetch DD contract address`);
            }
        }

        return ddContractAddr;
    }

    public async getDirectDepositFee(ddQueueAddress: string): Promise<bigint> {
        const dd = await this.getDdContract(ddQueueAddress);
        return BigInt(await this.contractCallRetry(dd, 'directDepositFee'));
    }

    public async createDirectDepositTx(
        ddQueueAddress: string,
        amount: bigint,
        zkAddress: string,
        fallbackAddress: string,
    ): Promise<PreparedTransaction> {
        const zkAddrBytes = `0x${Buffer.from(bs58.decode(zkAddress.substring(zkAddress.indexOf(':') + 1))).toString('hex')}`;
        const selector = 'directDeposit(address,uint256,bytes)';
        const parameters = [
            {type: 'address', value: fallbackAddress},
            {type: 'uint256', value: amount},
            {type: 'bytes', value: zkAddrBytes}
        ];
        
        return this.prepareTransaction(ddQueueAddress, selector, parameters);
    }

    public async createNativeDirectDepositTx(
        ddQueueAddress: string,
        nativeAmount: bigint,
        zkAddress: string,
        fallbackAddress: string,
    ): Promise<PreparedTransaction> {
        throw new InternalError(`Native direct deposits are currently unsupported for Tron deployments`)
    }

    public async getDirectDeposit(ddQueueAddress: string, idx: number, state: ZkBobState): Promise<DirectDeposit | undefined> {
        const dd = await this.getDdContract(ddQueueAddress);
        const ddInfo = await this.contractCallRetry(dd, 'getDirectDeposit', [idx]);
        const ddStatusCode = Number(ddInfo.status);
        if (ddStatusCode != 0) {
            return {
                id: BigInt(idx),            // DD queue unique identifier
                state: (ddStatusCode - 1) as DirectDepositState,
                amount: BigInt(ddInfo.deposit),        // in pool resolution
                destination: await state.assembleAddress(ddInfo.diversifier, ddInfo.pk),   // zk-addresss
                fee: BigInt(ddInfo.fee),           // relayer fee
                fallback: ddInfo.fallbackReceiver,      // 0x-address to refund DD
                sender: '',        // 0x-address of sender [to the queue]
                queueTimestamp: Number(ddInfo.timestamp), // when it was created
                queueTxHash: '',   // transaction hash to the queue
                //timestamp?: number;    // when it was sent to the pool
                //txHash?: string;       // transaction hash to the pool
                //payment?: DDPaymentInfo;
            };
        } 
        
        return undefined;
    }

    public async getDirectDepositNonce(ddQueueAddress: string): Promise<number> {
        const dd = await this.getDdContract(ddQueueAddress);
        return Number(await this.contractCallRetry(dd, 'directDepositNonce'));
    }

    // ------------------------=========< Signatures >=========-----------------------
    // | Signing and recovery                                                        |
    // -------------------------------------------------------------------------------

    public async sign(data: any, privKey: string): Promise<string> {
        if (typeof data === 'string') {
            const bytes = hexToBytes(data);
            return this.activeTronweb().trx.signMessageV2(bytes, privKey);
        }

        throw new Error('Incorrect signing request: data must be a hex string');
    }

    public async signTypedData(typedData: any, privKey: string): Promise<string> {
        if (typedData && typedData.domain && typedData.types && typedData.message) {
            return this.activeTronweb().trx._signTypedData(typedData.domain, typedData.types, typedData.message, privKey);
        }

        throw new Error('Incorrect typed signing request: it must contains at least domain, types and message keys');
    }

    public async recoverSigner(data: any, signature: string): Promise<string> {
        if (typeof data === 'string') {
            const bytes = hexToBytes(data);
            return this.activeTronweb().trx.verifyMessageV2(bytes, this.toCanonicalSignature(signature));
        }

        throw new Error('Cannot recover signature: data must be a hex string');
    }

    public async recoverSignerTypedData(typedData: any, signature: string): Promise<string> {
        throw new InternalError('recover typed data is unimplemented for Tron yet')
    }

    public toCompactSignature(signature: string): string {
        signature = truncateHexPrefix(signature);
      
        if (signature.length == 130) {
          // it seems it's an extended signature, let's compact it!
          const v = signature.slice(128).toLowerCase();
          if (v == '1c' || v == '01') {
            return `0x${signature.slice(0, 64)}${(parseInt(signature[64], 16) | 8).toString(16)}${signature.slice(65, 128)}`;
          } else if (v != '1b' && v != '00') {
            throw new InternalError('Invalid signature: v should be 27(0) or 28(1)');
          }
      
          return '0x' + signature.slice(0, 128);
        } else if (signature.length != 128) {
            throw new InternalError('Invalid signature: it should consist of 64 or 65 bytes (128\\130 chars)');
        }
      
        // it seems the signature already compact
        return '0x' + signature;
    }
    
    public toCanonicalSignature(signature: string): string {
        let sig = truncateHexPrefix(signature);
        
        if ((sig.length % 2) == 0) {
            if (sig.length == 128) {
                return `0x` + sig;
            } else if (sig.length == 130) {
                let v = '1b';
                if (parseInt(sig[64], 16) > 7) {
                    v = '1c';
                    sig = sig.slice(0, 64) + `${(parseInt(sig[64], 16) & 7).toString(16)}` + sig.slice(65);
                }
                return `0x` + sig + v;
            } else {
                throw new InternalError(`Incorrect signature length (${sig.length}), expected 64 or 65 bytes (128 or 130 chars)`);
            }
        } else {
            throw new InternalError(`Incorrect signature length (${sig.length}), expected an even number`);
        }
    }


    // ----------------------=========< Miscellaneous >=========----------------------
    // | Getting tx revert reason, chain ID, signature format, etc...                |
    // -------------------------------------------------------------------------------

    public validateAddress(address: string): boolean {
        return TronWeb.isAddress(address) && address != ZERO_ADDRESS;
    }

    public addressFromPrivateKey(privKeyBytes: Uint8Array): string {
        return TronWeb.address.fromPrivateKey(bufToHex(privKeyBytes));
    }

    public addressToBytes(address: string): Uint8Array {
        const hexAddr = TronWeb.address.toHex(address.length > 0 ? address : ZERO_ADDRESS);
        if (typeof hexAddr !== 'string' || hexAddr.length != 42) {
            throw new InternalError(`Incorrect address format`);
        }

        return hexToBuf(hexAddr.slice(2), 20);
    }

    public bytesToAddress(bytes: Uint8Array): string {
        const hexBytes = bufToHex(bytes);
        if (hexBytes.length == 42) {
            return TronWeb.address.fromHex(hexBytes)
        } else if (hexBytes.length == 40) {
            return TronWeb.address.fromHex('41' + hexBytes)
        }

        throw new InternalError(`Incorrect address buffer`);
    }

    public isEqualAddresses(addr1: string, addr2: string): boolean {
        return addr1 == addr2;;
    }

    public txHashFromHexString(hexString: string): string {
        return truncateHexPrefix(hexString);
    }

    public async getTxRevertReason(txHash: string): Promise<string | null> {
        try {
            const txInfo = await this.commonRpcRetry(async () => {
                return this.activeTronweb().trx.getTransactionInfo(txHash);
            }, '[TronNetwork] Cannot get transaction', RETRY_COUNT);

            if (txInfo && txInfo.receipt) {
                if (txInfo.result && txInfo.result == 'FAILED') {
                    if (txInfo.resMessage) {
                        return this.tronWeb.toAscii(txInfo.resMessage);
                    }

                    return 'UNKNOWN_REASON';
                }
            }
        } catch(err) {
            console.warn(`[TronNetwork] error on checking tx ${txHash}: ${err.message}`);
        }

        return null;
    }

    public async getChainId(): Promise<number> {
        if (this.chainId === undefined) {
            // tronweb cannot fetch chainId
            // so we should request it directly from the JSON RPC endpoint
            const tryUrls = [`${this.curRpcUrl()}jsonrpc`, this.curRpcUrl()];
            for (let aAttemptUrl of tryUrls) {
                try {
                    const chainId = await this.fetchChainIdFrom(aAttemptUrl);
                    this.chainId = chainId;
                    return chainId;
                } catch(err) {
                    console.warn(`Cannot fetch chainId from ${aAttemptUrl}: ${err.message}`);
                }
            }

            // unable to fetch
            throw new InternalError('Unable to get actual chainId');
        }

        return this.chainId;
    }

    public async getNativeBalance(address: string): Promise<bigint> {
        return this.commonRpcRetry(async () => {
            return BigInt(await this.activeTronweb().trx.getBalance(address));
        }, '[TronNetwork] Cannot get native balance', RETRY_COUNT);
    }

    public async getNativeNonce(address: string): Promise<number> {
        return 0;
    }

    public async getTxDetails(index: number, poolTxHash: string, state: ZkBobState): Promise<PoolTxDetails | null> {
        try {
            const tronTransaction = await this.commonRpcRetry(async () => {
                return this.activeTronweb().trx.getTransaction(poolTxHash);
            }, '[TronNetwork] Cannot get transaction', RETRY_COUNT);
            const txState = await this.getTransactionState(poolTxHash);
            const timestamp = tronTransaction?.raw_data?.timestamp
            const contract = tronTransaction?.raw_data?.contract;
            let txData: any | undefined;
            if (Array.isArray(contract) && contract.length > 0) {
                txData = truncateHexPrefix(contract[0].parameter?.value?.data);
            }

            if (txData && timestamp) {
                let isMined = txState == L1TxState.MinedSuccess;

                const txSelector = txData.slice(0, 8).toLowerCase();
                if (txSelector == PoolSelector.Transact) {
                    const txInfo = await parseTransactCalldata(txData, this);
                        txInfo.txHash = poolTxHash;
                        txInfo.isMined = isMined;
                        txInfo.timestamp = timestamp / 1000;    // timestamp should be in seconds but tronweb returns ms
                        
                        return {
                            poolTxType: PoolTxType.Regular,
                            details: txInfo,
                            index,
                        };
                } else if (txSelector == PoolSelector.AppendDirectDeposit) {
                    const txInfo = new DDBatchTxDetails();
                    txInfo.txHash = poolTxHash;
                    txInfo.isMined = isMined;
                    txInfo.timestamp = timestamp / 1000;
                    txInfo.deposits = [];

                    // TODO: decode input with ABI, request DDs by indexes

                    return {
                        poolTxType: PoolTxType.DirectDepositBatch,
                        details: txInfo,
                        index,
                    };
                } else {
                    throw new InternalError(`[TronNetwork]: Cannot decode calldata for tx ${poolTxHash} (incorrect selector ${txSelector})`);
                }
            } else {
              console.warn(`[TronNetwork]: cannot get native tx ${poolTxHash} (tx still not mined?)`);
            }
        } catch (err) {
            console.warn(`[TronNetwork]: cannot get native tx ${poolTxHash} (${err.message})`);
        }
          
        return null;
    }

    public calldataBaseLength(ver: TxCalldataVersion): number {
        return CalldataInfo.baseLength(ver);
    }

    public estimateCalldataLength(ver: TxCalldataVersion, txType: RegularTxType, notesCnt: number, extraDataLen: number = 0): number {
        return CalldataInfo.estimateEvmCalldataLength(ver, txType, notesCnt, extraDataLen)
    }

    public async getTransactionState(txHash: string): Promise<L1TxState> {
        try {
            const txInfo = await this.commonRpcRetry(async () => {
                return this.activeTronweb().trx.getTransactionInfo(txHash);
            }, '[TronNetwork] Cannot get transaction', RETRY_COUNT);

            if (txInfo && txInfo.receipt) {
                // tx is on the blockchain (assume mined)
                if (txInfo.result && txInfo.result == 'FAILED') {
                    return L1TxState.MinedFailed;
                }

                return L1TxState.MinedSuccess;
            }
        } catch(err) {
            console.warn(`[TronNetwork] error on checking tx ${txHash}: ${err.message}`);
        }

        return L1TxState.NotFound;
    }


    // xxxxxxxxxxxxxxxxxxxxXXXXXXXXX< Private routines >XXXXXXXXXxxxxxxxxxxxxxxxxxxxxx
    // x Sending tx, working with energy and others                                  x
    // xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

    private async fetchChainIdFrom(url: string): Promise<number> {
        const body = {"jsonrpc":"2.0", "method": "eth_chainId", "params": [], "id": 1};
        const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {'Content-Type': 'application/json; charset=UTF-8'} });
          
        if (!response.ok) {
            throw new Error(`Cannot fetch from JSON RPC (error ${response.status}): ${response.body ?? 'no description'}`);
        }
        
        const json = await response.json();
        if (json && json.result) {
            return Number(json.result);
        }

        throw new Error(`Cannot fetch from JSON RPC: incorrect response JSON (${json})`);
    }
    
    private async getEnergyCost(): Promise<number> {
        if (this.energyFee === undefined) {
            try {
                const chainParams = await this.commonRpcRetry(async () => {
                    return this.activeTronweb().trx.getChainParameters();
                }, '[TronNetwork] Cannot get chain parameters', RETRY_COUNT);
                for (let aParam of chainParams) {
                    if (aParam.key == 'getEnergyFee') {
                        this.energyFee = Number(aParam.value);
                        return this.energyFee;
                    }
                }

                console.warn(`Cannot get energy fee: no such key in chain parameters (getEnergyFee). Will using defaul ${DEFAULT_ENERGY_FEE}`);
            } catch(err) {
                console.warn(`Cannot get energy fee: ${err}`);
            }
        }

        return this.energyFee ?? DEFAULT_ENERGY_FEE;

    }

    private async getAccountEnergy(address: string): Promise<number> {
        try {
            const accResources = await this.commonRpcRetry(async () => {
                return this.activeTronweb().trx.getAccountResources(address);
            }, '[TronNetwork] Cannot get account resources', RETRY_COUNT);
            return Number(accResources.EnergyLimit ?? 0) - Number(accResources.EnergyUsed ?? 0);
        } catch(err) {
            console.warn(`Cannot get account energy: ${err}`);
        }
        
        return 0;
    }

    private async verifyAndSendTx(
        contractAddress: string,
        selector: string,
        parameters: Array<object>,
        privateKey: string,
        feeLimit: number = 100_000_000,
        validateBalance: boolean = true,
    ): Promise<string> {
        // create tx to validate it's correct
        const signerAddress = TronWeb.address.fromPrivateKey(privateKey);
        let tx = await this.activeTronweb().transactionBuilder.triggerConstantContract(contractAddress, selector, { feeLimit }, parameters, signerAddress)
            .catch((err: string) => {
                throw new Error(`Tx validation error: ${err}`);
            });

        if (validateBalance) {
            // Check is sufficient resources for the fee
            const sender = TronWeb.address.fromPrivateKey(truncateHexPrefix(privateKey));
            const energyCost = await this.getEnergyCost();;
            const accEnergy = await this.getAccountEnergy(sender);
            const accBalance = Number(await this.getNativeBalance(sender));
            const neededForFee = tx.energy_used * energyCost;
            // TODO: take into account bandwidth consumption
            if ((accBalance + energyCost * accEnergy) < neededForFee) {
                throw new Error(`Insufficient balance for fee (available ${accBalance} sun + ${accEnergy} energy, needed at least ${neededForFee})`)
            };
        }

        // create actual tx with feeLimit field
        // it's a tronweb bug: triggerConstantContract doesn't include feeLimit in the transaction
        // so it can be reverted in case of out-of-energy
        tx = await this.activeTronweb().transactionBuilder.triggerSmartContract(contractAddress, selector, { feeLimit }, parameters, signerAddress);
        // sign and send
        const signedTx = await this.activeTronweb().trx.sign(tx.transaction, privateKey);
        const result = await this.activeTronweb().trx.sendRawTransaction(signedTx);

        return result.txid;
    }

    // ----------------------=========< Syncing >=========----------------------
    // | Getting block number, waiting for a block...                          |
    // -------------------------------------------------------------------------

    public async getBlockNumber(): Promise<number> {
        return this.commonRpcRetry(async () => {
            const block = await this.activeTronweb().trx.getCurrentBlock();
            return block.block_header.raw_data.number;
        }, '[TronNetwork] Cannot get block number', RETRY_COUNT);
    }

    public async getBlockNumberFrom(rpcurl: string): Promise<number> {
        const tmpTronweb = new TronWeb({
            fullHost: rpcurl,
            privateKey: '01',
        });
        return this.commonRpcRetry(async () => {
            const block = await tmpTronweb.trx.getCurrentBlock();
            return block.block_header.raw_data.number;
        }, `[TronNetwork] Cannot get block number from ${rpcurl}`, 2);
    }

    public async waitForBlock(blockNumber: number, timeoutSec?: number): Promise<boolean> {
        const startTime = Date.now();
        const SWITCH_RPC_DELAY = 60;
        let curBlock: number;
        let waitMsgLogged = false;
        do {
            curBlock = await this.getBlockNumber().catch(() => 0);

            if (Date.now() > startTime + (timeoutSec ?? Number.MAX_SAFE_INTEGER) * 1000) {
                console.warn(`[TronNetwork]: timeout reached while waiting for a block ${blockNumber} (current block ${curBlock})`)
                return false;
            }

            if (curBlock < blockNumber) {
                if (!waitMsgLogged) {
                    console.warn(`[TronNetwork]: waiting for a block ${blockNumber} (current ${curBlock})...`);
                    waitMsgLogged = true;
                }

                if (Date.now() > startTime + SWITCH_RPC_DELAY * 1000) {
                    if (await this.switchToTheBestRPC()) {
                        console.warn(`[TronNetwork]: RPC was auto switched because the block ${blockNumber} was not reached yet`);
                    }
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } while(curBlock < blockNumber);

        if (waitMsgLogged) {
            console.log(`[TronNetwork]: internal provider was synced with block ${blockNumber}`);
        }

        return true;
    }

}