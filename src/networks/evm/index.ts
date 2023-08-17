import Web3 from 'web3';
import { Contract } from 'web3-eth-contract'
import { TransactionConfig } from 'web3-core'
import { NetworkBackend, PreparedTransaction} from '../network';
import { InternalError } from '../../errors';
import { ddContractABI, poolContractABI, tokenABI } from './evm-abi';
import bs58 from 'bs58';
import { DDBatchTxDetails, RegularTxDetails, ShieldedTx, PoolTxDetails, RegularTxType, PoolTxType } from '../../tx';
import { bigintToArrayLe, bufToHex, toCanonicalSignature } from '../../utils';
import { DirectDepositState } from '../../dd';
import { CALLDATA_BASE_LENGTH, decodeEvmCalldata, estimateEvmCalldataLength, getCiphertext } from './calldata';
import { time } from 'console';

const RPC_ISSUES_THRESHOLD = 10;

export enum PoolSelector {
    Transact = "af989083",
    AppendDirectDeposit = "1dc4cb33",
  }

export class EvmNetwork implements NetworkBackend {
    // RPC URL management
    private rpcUrls: string[];
    private curRpcIdx: number;
    private curRpcIssues = 0;
    private badRpcs: number[] = []; // RPC indexes which are considered to be unstable or unavailable

    // These properties can be undefined when backend in the disabled state
    private web3?: Web3;
    private pool?: Contract;
    private dd?: Contract;
    private token?: Contract;

    // Local cache
    private tokenSellerAddresses = new Map<string, string>();    // poolContractAddress -> tokenSellerContractAddress
    private ddContractAddresses = new Map<string, string>();    // poolContractAddress -> directDepositContractAddress

    // ------------------------=========< Lifecycle >=========------------------------
    // | Init, enabling and disabling backend                                        |
    // -------------------------------------------------------------------------------

    constructor(rpcUrls: string[], enabled: boolean = true) {
        if (rpcUrls.length == 0) {
            throw new InternalError(`Unable to initialize EvmNetwork without RPC URL`);
        }

        this.rpcUrls = rpcUrls;
        this.curRpcIdx = -1;

        if (enabled) {
            this.setEnabled(true);
        }
    }

    public isEnabled(): boolean {
        return this.web3 !== undefined &&
                this.pool !== undefined &&
                this.dd !== undefined &&
                this.token !== undefined;
    }

    public setEnabled(enabled: boolean) {
        if (enabled) {
            if (!this.isEnabled()) {
                this.web3 = new Web3(this.curRpcUrl());
                this.pool = new this.web3.eth.Contract(poolContractABI) as unknown as Contract;
                this.dd = new this.web3.eth.Contract(ddContractABI) as unknown as Contract;
                this.token = new this.web3.eth.Contract(tokenABI) as unknown as Contract;
            }
        } else {
            this.web3 = undefined;
            this.pool = undefined;
            this.dd = undefined;
            this.token = undefined;
        }
    }

    private activeWeb3(): Web3 {
        if (!this.web3) {
            throw new InternalError(`EvmNetwork: Cannot interact in the disabled mode`);
        }

        return this.web3;
    }

    private poolContract(): Contract {
        if (!this.pool) {
            throw new InternalError(`EvmNetwork: pool contract object is undefined`);
        }

        return this.pool;
    }

    private directDepositContract(): Contract {
        if (!this.dd) {
            throw new InternalError(`EvmNetwork: direct deposit contract object is undefined`);
        }

        return this.dd;
    }

    private tokenContract(): Contract {
        if (!this.token) {
            throw new InternalError(`EvmNetwork: token contract object is undefined`);
        }

        return this.token;
    }

    // ----------------------=========< RPC switching >=========----------------------
    // | Getting current RPC, registering issues, switching between RPCs             |
    // -------------------------------------------------------------------------------

    public curRpcUrl(): string {
        if (this.curRpcIdx < 0) {
            return this.rpcUrls[0];
        } else if (this.curRpcIdx >= this.rpcUrls.length) {
            return this.rpcUrls[this.rpcUrls.length - 1];
        } else {
            return this.rpcUrls[this.curRpcIdx];
        }
    }

    // Call this routine to increase issue counter
    // The RPC will be swiching automatically on threshold
    private registerRpcIssue() {
        if (++this.curRpcIssues >= RPC_ISSUES_THRESHOLD) {
            if (this.switchRPC(undefined, true)) {
                this.curRpcIssues = 0;
            }
        }
    }

    private switchRPC(index?: number, markCurrentAsBad: boolean = true): boolean {
        if (markCurrentAsBad && !this.badRpcs.includes(this.curRpcIdx)) {
            this.badRpcs.push(this.curRpcIdx);
            console.log(`[EvmNetwork]: RPC ${this.curRpcUrl()} marked as bad (${this.curRpcIssues} issues registered)`);
        }


        let newRpcIndex = index ?? this.curRpcIdx;
        if (index === undefined && this.rpcUrls.length > 1) {
            let passesCnt = 0;
            do {
                newRpcIndex = (newRpcIndex + 1) % this.rpcUrls.length;
                if (!this.badRpcs.includes(newRpcIndex) || passesCnt > 0) {
                    break;
                }

                if (newRpcIndex == this.curRpcIdx) {
                    passesCnt++;
                }
            } while(passesCnt < 2)
        }

        if (newRpcIndex != this.curRpcIdx) {
            this.curRpcIdx = newRpcIndex;
            this.web3 = new Web3(this.curRpcUrl());
            console.log(`[EvmNetwork]: RPC was switched to ${this.curRpcUrl()}`);

            return true;
        }

        return false;
    }


    // -----------------=========< Token-Related Routiness >=========-----------------
    // | Getting balance, allowance, nonce etc                                       |
    // -------------------------------------------------------------------------------

    public async getDomainSeparator(tokenAddress: string): Promise<string> {
        this.tokenContract().options.address = tokenAddress;
        return await this.tokenContract().methods.DOMAIN_SEPARATOR().call();
    }

    public async getTokenName(tokenAddress: string): Promise<string> {
        this.tokenContract().options.address = tokenAddress;
        return await this.tokenContract().methods.name().call();
    }

    public async getTokenDecimals(tokenAddress: string): Promise<number> {
        this.tokenContract().options.address = tokenAddress;
        return Number(await this.tokenContract().methods.decimals().call());
    }
    
    public async getTokenNonce(tokenAddress: string, address: string): Promise<number> {
        this.tokenContract().options.address = tokenAddress;
        return Number(await this.tokenContract().methods.nonces(address).call());
    }

    public async getTokenBalance(tokenAddress: string, address: string): Promise<bigint> {    // in wei
        this.tokenContract().options.address = tokenAddress;
        return BigInt(await this.tokenContract().methods.balanceOf(address).call());
    }

    public async allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
        this.tokenContract().options.address = tokenAddress;
        const result = await this.tokenContract().methods.allowance(owner, spender).call();
    
        return BigInt(result);
    }

    public async permit2NonceBitmap(permit2Address: string, owner: string, wordPos: bigint): Promise<bigint> {
        this.tokenContract().options.address = permit2Address;
        const result = await this.tokenContract().methods.nonceBitmap(owner, wordPos).call();

        return BigInt(result);
    }

    public async erc3009AuthState(tokenAddress: string, authorizer: string, nonce: bigint): Promise<bigint> {
        this.tokenContract().options.address = tokenAddress;
        const result = await this.tokenContract().methods.authorizationState(authorizer, `0x${nonce.toString(16)}`).call();

        return BigInt(result);
    }

    public async approveTokens(
        tokenAddress: string,
        privateKey: string,
        holder: string,
        spender: string,
        amount: bigint,
        gasFactor?: number
    ): Promise<string> {
        const encodedTx = await this.tokenContract().methods.approve(spender, BigInt(amount)).encodeABI();
        let txObject: TransactionConfig = {
            from: holder,
            to: tokenAddress,
            data: encodedTx,
        };

        const gas = await this.activeWeb3().eth.estimateGas(txObject);
        const gasPrice = Number(await this.activeWeb3().eth.getGasPrice());
        const nonce = await this.activeWeb3().eth.getTransactionCount(holder);
        txObject.gas = gas;
        txObject.gasPrice = `0x${BigInt(Math.ceil(gasPrice * (gasFactor ?? 1.0))).toString(16)}`;
        txObject.nonce = nonce;

        const signedTx = await this.activeWeb3().eth.accounts.signTransaction(txObject, privateKey);
        const receipt = await this.activeWeb3().eth.sendSignedTransaction(signedTx.rawTransaction ?? '');

        return receipt.transactionHash;
    }


    // ---------------------=========< Pool Interaction >=========--------------------
    // | Getting common info: pool ID, denominator, limits etc                       |
    // -------------------------------------------------------------------------------

    public async getPoolId(poolAddress: string): Promise<number> {
        this.poolContract().options.address = poolAddress;
        return Number(await this.poolContract().methods.pool_id().call());
    }

    public async getDenominator(poolAddress: string): Promise<bigint> {
        this.poolContract().options.address = poolAddress;
        return BigInt(await this.poolContract().methods.denominator().call());
    }

    public async poolState(poolAddress: string, index?: bigint): Promise<{index: bigint, root: bigint}> {
        this.poolContract().options.address = poolAddress;
        let idx;
        if (index === undefined) {
            idx = await this.poolContract().methods.pool_index().call();
        } else {
            idx = index?.toString();
        }
        const root = await this.poolContract().methods.roots(idx).call();


        return {index: BigInt(idx), root: BigInt(root)};
    }

    public async poolLimits(poolAddress: string, address: string | undefined): Promise<any> {
        this.poolContract().options.address = poolAddress;
        let addr = address;
        if (address === undefined) {
            addr = '0x0000000000000000000000000000000000000000';
        }
        
        return await this.poolContract().methods.getLimitsFor(addr).call();
    }

    public async getTokenSellerContract(poolAddress: string): Promise<string> {
        let tokenSellerAddr = this.tokenSellerAddresses.get(poolAddress);
        if (!tokenSellerAddr) {
            this.poolContract().options.address = poolAddress;
            tokenSellerAddr = await this.poolContract().methods.tokenSeller().call();
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
            this.poolContract().options.address = poolAddress;
            ddContractAddr = await this.poolContract().methods.direct_deposit_queue().call();
            if (ddContractAddr) {
                this.ddContractAddresses.set(poolAddress, ddContractAddr);
            } else {
                throw new InternalError(`Cannot fetch DD contract address`);
            }
        }

        return ddContractAddr;
    }

    public async getDirectDepositFee(ddQueueAddress: string): Promise<bigint> {
        this.directDepositContract().options.address = ddQueueAddress;
        
        return BigInt(await this.directDepositContract().methods.directDepositFee().call());
    }

    public async createDirectDepositTx(
        ddQueueAddress: string,
        amount: bigint,
        zkAddress: string,
        fallbackAddress: string,
    ): Promise<PreparedTransaction> {
        const zkAddrBytes = `0x${Buffer.from(bs58.decode(zkAddress.substring(zkAddress.indexOf(':') + 1))).toString('hex')}`;
        const encodedTx = await this.directDepositContract().methods["directDeposit(address,uint256,bytes)"](fallbackAddress, amount, zkAddrBytes).encodeABI();

        return {
            to: ddQueueAddress,
            amount: 0n,
            data: encodedTx,
        };
    }

    public async createNativeDirectDepositTx(
        ddQueueAddress: string,
        nativeAmount: bigint,
        zkAddress: string,
        fallbackAddress: string,
    ): Promise<PreparedTransaction> {
        const zkAddrBytes = `0x${Buffer.from(bs58.decode(zkAddress.substring(zkAddress.indexOf(':') + 1))).toString('hex')}`;
        const encodedTx = await this.directDepositContract().methods["directNativeDeposit(address,bytes)"](fallbackAddress, zkAddrBytes).encodeABI();

        return {
            to: ddQueueAddress,
            amount: nativeAmount,
            data: encodedTx,
        };
    }


    // ----------------------=========< Miscellaneous >=========----------------------
    // | Getting tx revert reason, chain ID, signature format, etc...                |
    // -------------------------------------------------------------------------------

    public async getTxRevertReason(txHash: string): Promise<string | null> {
        const txReceipt = await this.activeWeb3().eth.getTransactionReceipt(txHash);
        if (txReceipt && txReceipt.status !== undefined) {
            if (txReceipt.status == false) {
                const txData = await this.activeWeb3().eth.getTransaction(txHash);
                
                let reason = 'unknown reason';
                try {
                    await this.activeWeb3().eth.call(txData as TransactionConfig, txData.blockNumber as number);
                } catch(err) {
                    reason = err.message;
                }
                console.log(`getTxRevertReason: revert reason for ${txHash}: ${reason}`)

                return reason;
            } else {
                console.warn(`getTxRevertReason: ${txHash} was not reverted`);
            }
        } else {
            console.warn(`getTxRevertReason: ${txHash} was not mined yet`);
        }

        return null;
    }

    public isSignatureCompact(): boolean {
        return true;
    }

    public async getChainId(): Promise<number> {
        return await this.activeWeb3().eth.getChainId();
    }

    public async getNativeBalance(address: string): Promise<bigint> {
        return BigInt(await this.activeWeb3().eth.getBalance(address));
    }

    public async getNativeNonce(address: string): Promise<number> {
        return Number(await this.activeWeb3().eth.getTransactionCount(address))
    }

    public async getTxDetails(poolTxHash: string): Promise<PoolTxDetails | null> {
        try {
            const txData = await this.activeWeb3().eth.getTransaction(poolTxHash);
            if (txData && txData.blockNumber && txData.input) {
                //
                const block = await this.activeWeb3().eth.getBlock(txData.blockNumber).catch(() => null);
                if (block && block.timestamp) {
                    let timestamp: number = 0;
                    if (typeof block.timestamp === "number" ) {
                        timestamp = block.timestamp;
                    } else if (typeof block.timestamp === "string" ) {
                        timestamp = Number(block.timestamp);
                    }

                    let isMined = false;
                    const txReceipt = await this.activeWeb3().eth.getTransactionReceipt(poolTxHash);
                    if (txReceipt && txReceipt.status !== undefined && txReceipt.status == true) {
                        isMined = true;
                    }

                    const txSelector = txData.input.slice(2, 10).toLowerCase();
                    if (txSelector == PoolSelector.Transact) {
                        const tx = decodeEvmCalldata(txData.input);
                        const feeAmount = BigInt('0x' + tx.memo.slice(0, 16));
                        
                        const txInfo = new RegularTxDetails();
                        txInfo.txType = tx.txType;
                        txInfo.tokenAmount = tx.tokenAmount;
                        txInfo.feeAmount = feeAmount;
                        txInfo.txHash = poolTxHash;
                        txInfo.isMined = isMined
                        txInfo.timestamp = timestamp;
                        txInfo.nullifier = '0x' + tx.nullifier.toString(16).padStart(64, '0');
                        txInfo.commitment = '0x' + bufToHex(bigintToArrayLe(tx.outCommit));
                        txInfo.ciphertext = getCiphertext(tx);

                        // additional tx-specific fields for deposits and withdrawals
                        if (tx.txType == RegularTxType.Deposit) {
                            if (tx.extra && tx.extra.length >= 128) {
                                const fullSig = toCanonicalSignature(tx.extra.slice(0, 128));
                                txInfo.depositAddr = await this.activeWeb3().eth.accounts.recover(txInfo.nullifier, fullSig);
                            } else {
                                //incorrect signature
                                throw new InternalError(`No signature for approve deposit`);
                            }
                        } else if (tx.txType == RegularTxType.BridgeDeposit) {
                            txInfo.depositAddr = '0x' + tx.memo.slice(32, 72);
                        } else if (tx.txType == RegularTxType.Withdraw) {
                            txInfo.withdrawAddr = '0x' + tx.memo.slice(32, 72);
                        }

                        return {
                            poolTxType: PoolTxType.Regular,
                            details: txInfo,
                        };
                    } else if (txSelector == PoolSelector.AppendDirectDeposit) {
                        const txInfo = new DDBatchTxDetails();
                        txInfo.id = 0n, // TODO!!!
                        txInfo.state = DirectDepositState.Queued, // TODO!!!
                        txInfo.DDs = [];    // TODO!!!
                        txInfo.txHash = poolTxHash;
                        txInfo.isMined = isMined;
                        txInfo.timestamp = timestamp;

                        // WIP

                        return {
                            poolTxType: PoolTxType.DirectDepositBatch,
                            details: txInfo,
                        };
                    } else {
                        throw new InternalError(`[EvmNetwork]: Cannot decode calldata for tx ${poolTxHash} (incorrect selector ${txSelector})`);
                    }
                } else {
                    console.warn(`[EvmNetwork]: cannot get block (${txData.blockNumber}) to retrieve timestamp`);      
                }
            } else {
              console.warn(`[EvmNetwork]: cannot get native tx ${poolTxHash} (tx still not mined?)`);
            }
        } catch (err) {
            console.warn(`[EvmNetwork]: cannot get native tx ${poolTxHash} (${err.message})`);
        }
          
        return null;
    }

    public calldataBaseLength(): number {
        return CALLDATA_BASE_LENGTH;
    }

    public estimateCalldataLength(txType: RegularTxType, notesCnt: number, extraDataLen: number = 0): number {
        return estimateEvmCalldataLength(txType, notesCnt, extraDataLen)
    }
}