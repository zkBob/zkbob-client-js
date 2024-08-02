import Web3 from 'web3';
import { Contract } from 'web3-eth-contract'
import { TransactionConfig } from 'web3-core'
import { NetworkBackend, PreparedTransaction, L1TxState} from '..';
import { InternalError } from '../../errors';
import { accountingABI, ddContractABI, poolContractABI, tokenABI } from './evm-abi';
import bs58 from 'bs58';
import { DDBatchTxDetails, RegularTxDetails, PoolTxDetails, RegularTxType, PoolTxType, DirectDeposit, DirectDepositState, TxCalldataVersion } from '../../tx';
import { addHexPrefix, bufToHex, hexToBuf, toTwosComplementHex, truncateHexPrefix } from '../../utils';
import { CalldataInfo, parseTransactCalldata, parseDirectDepositCalldata } from './calldata';
import { recoverTypedSignature, signTypedData, SignTypedDataVersion,
        personalSign, recoverPersonalSignature } from '@metamask/eth-sig-util'
import { privateToAddress, bufferToHex, isHexPrefixed } from '@ethereumjs/util';
import { isAddress } from 'web3-utils';
import { Transaction, TransactionReceipt } from 'web3-core';
import { RpcManagerDelegate, MultiRpcManager } from '../rpcman';
import { ZkBobState } from '../../state';
import { CommittedForcedExit, FinalizedForcedExit, ForcedExitRequest } from '../../emergency';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_ADDRESS1 = '0x0000000000000000000000000000000000000001';

export enum PoolSelector {
    Transact = "af989083",
    AppendDirectDeposit = "1dc4cb33",
    AppendDirectDepositV2 = "e6b14272",
    TransactV2 = "5fd28f8c",
}

export enum ZkBobContractType {
    Pool = "pool",
    DD = "direct deposit",
    Token = "token",
    Accounting = "accounting"
}

export class EvmNetwork extends MultiRpcManager implements NetworkBackend, RpcManagerDelegate {
    // These properties can be undefined when backend in the disabled state
    private web3?: Web3;
    private pool?: Contract;
    private dd?: Contract;
    private token?: Contract;
    private accounting?: Contract;

    // Local cache
    private tokenSellerAddresses = new Map<string, string>();   // poolContractAddress -> tokenSellerContractAddress
    private ddContractAddresses = new Map<string, string>();    // poolContractAddress -> directDepositContractAddress
    private accountingAddresses = new Map<string, string>();    // poolContractAddress -> accountingContractAddress
    private supportedMethods = new Map<string, boolean>();      // (contractAddress + methodName) => isSupported

    // ------------------------=========< Lifecycle >=========------------------------
    // | Init, enabling and disabling backend                                        |
    // -------------------------------------------------------------------------------

    constructor(rpcUrls: string[], enabled: boolean = true) {
        super(rpcUrls);
        super.delegate = this;

        if (enabled) {
            this.setEnabled(true);
        }
    }

    public isEnabled(): boolean {
        return this.web3 !== undefined &&
                this.pool !== undefined &&
                this.dd !== undefined &&
                this.token !== undefined &&
                this.accounting !== undefined;
    }

    public setEnabled(enabled: boolean) {
        if (enabled) {
            if (!this.isEnabled()) {
                this.web3 = new Web3(super.curRpcUrl());
                this.pool = new this.web3.eth.Contract(poolContractABI) as unknown as Contract;
                this.dd = new this.web3.eth.Contract(ddContractABI) as unknown as Contract;
                this.token = new this.web3.eth.Contract(tokenABI) as unknown as Contract;
                this.accounting = new this.web3.eth.Contract(accountingABI) as unknown as Contract;
            }
        } else {
            this.web3 = undefined;
            this.pool = undefined;
            this.dd = undefined;
            this.token = undefined;
            this.accounting = undefined;
        }
    }

    private activeWeb3(): Web3 {
        if (!this.web3) {
            throw new InternalError(`EvmNetwork: Cannot interact in the disabled mode`);
        }

        return this.web3;
    }

    /*private poolContract(): Contract {
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

    private accountingContract(): Contract {
        if (!this.accounting) {
            throw new InternalError(`EvmNetwork: accounting contract object is undefined`);
        }

        return this.accounting;
    }*/

    private contractByType(type: ZkBobContractType): Contract {
        let res: Contract | undefined;
        switch (type) {
            case ZkBobContractType.Pool: res = this.pool; break;
            case ZkBobContractType.DD: res = this.dd; break;
            case ZkBobContractType.Token: res = this.token; break;
            case ZkBobContractType.Accounting: res = this.accounting; break;
        }

        if (!res) {
            throw new InternalError(`EvmNetwork: ${type} contract object is undefined`);
        }

        return res;
    }

    private contractCallRetry(contractType: ZkBobContractType, address: string, method: string, args: any[] = []): Promise<any> {
        return this.commonRpcRetry(async () => {
                const contract = this.contractByType(contractType);
                contract.options.address = address;
                return await contract.methods[method](...args).call()
            },
            `[EvmNetwork] Contract call (${method}) error`
        );
    }

    private async isMethodSupportedByContract(
        contract: Contract,
        address: string,
        methodName: string,
        testParams: any[] = [],
    ): Promise<boolean> {
        const mapKey = address + methodName;
        let isSupport = this.supportedMethods.get(mapKey);
        if (isSupport === undefined) {
            try {
                contract.options.address = address;
                await contract.methods[methodName](...testParams).call()
                isSupport = true;
            } catch (err) {
                console.warn(`The contract seems doesn't support \'${methodName}\' method`);
                isSupport = false;
            }

            this.supportedMethods.set(mapKey, isSupport);
        };

        return isSupport
    }
    
    // -----------------=========< Token-Related Routiness >=========-----------------
    // | Getting balance, allowance, nonce etc                                       |
    // -------------------------------------------------------------------------------

    public async getTokenName(tokenAddress: string): Promise<string> {
        return this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'name');
    }

    public async getTokenDecimals(tokenAddress: string): Promise<number> {
        const res = await this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'decimals');
        return Number(res);
    }

    public async getDomainSeparator(tokenAddress: string): Promise<string> {
        return this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'DOMAIN_SEPARATOR');
    }
    
    public async getTokenNonce(tokenAddress: string, address: string): Promise<number> {
        const res = await this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'nonces', [address]);
        return Number(res);
    }

    public async getTokenBalance(tokenAddress: string, address: string): Promise<bigint> {    // in token base units
        const res = await this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'balanceOf', [address]);
        return BigInt(res);
    }

    public async allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
        const res = await this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'allowance', [owner, spender]);
        return BigInt(res);
    }

    public async permit2NonceBitmap(permit2Address: string, owner: string, wordPos: bigint): Promise<bigint> {
        const res = await this.contractCallRetry(ZkBobContractType.Token, permit2Address, 'nonceBitmap', [owner, wordPos]);
        return BigInt(res);
    }

    public async erc3009AuthState(tokenAddress: string, authorizer: string, nonce: bigint): Promise<bigint> {
        const res = await this.contractCallRetry(ZkBobContractType.Token, tokenAddress, 'authorizationState', [authorizer, `0x${nonce.toString(16)}`]);
        return BigInt(res);
    }

    public async approveTokens(
        tokenAddress: string,
        privateKey: string,
        holder: string,
        spender: string,
        amount: bigint,
        gasFactor?: number
    ): Promise<string> {
        const encodedTx = await this.contractByType(ZkBobContractType.Token).methods.approve(spender, BigInt(amount)).encodeABI();
        let txObject: TransactionConfig = {
            from: holder,
            to: tokenAddress,
            data: encodedTx,
        };

        const gas = await this.commonRpcRetry(async () => {
            return Number(await this.activeWeb3().eth.estimateGas(txObject));
        }, 'Unable to estimate gas');
        const gasPrice = await this.commonRpcRetry(async () => {
            return Number(await this.activeWeb3().eth.getGasPrice());
        }, 'Unable to get gas price');
        txObject.gas = gas;
        txObject.gasPrice = `0x${BigInt(Math.ceil(gasPrice * (gasFactor ?? 1.0))).toString(16)}`;
        txObject.nonce = await this.getNativeNonce(holder);

        const signedTx = await this.activeWeb3().eth.accounts.signTransaction(txObject, privateKey);

        const receipt = await this.commonRpcRetry(async () => {
            return this.activeWeb3().eth.sendSignedTransaction(signedTx.rawTransaction ?? '');
        }, 'Unable to send approve tx', true); // do not retry sending to avoid any side effects

        return receipt.transactionHash;
    }

    public async isSupportNonce(tokenAddress: string): Promise<boolean> {
        const tokenContract = this.contractByType(ZkBobContractType.Token);
        return this.isMethodSupportedByContract(tokenContract, tokenAddress, 'nonces', [ZERO_ADDRESS]);
    }


    // ---------------------=========< Pool Interaction >=========--------------------
    // | Getting common info: pool ID, denominator, limits etc                       |
    // -------------------------------------------------------------------------------

    public async getPoolId(poolAddress: string): Promise<number> {
        return Number(await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'pool_id'));
    }

    public async getDenominator(poolAddress: string): Promise<bigint> {
        return BigInt(await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'denominator'));
    }

    public async poolState(poolAddress: string, index?: bigint): Promise<{index: bigint, root: bigint}> {
        let idx: string;
        if (index === undefined) {
            idx = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'pool_index');
        } else {
            idx = index?.toString();
        }
        let root = BigInt(await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'roots', [idx]));
        if (root == 0n) {
            // it's seems the RPC node got behind the actual blockchain state
            // let's try to find the best one and retry root request
            const switched = await this.switchToTheBestRPC();
            if (switched) {
                root = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'roots', [idx]);
            }
            if (root == 0n) {
                console.warn(`[EvmNetwork] cannot retrieve root at index ${idx} (is it exist?)`);
            }
        }

        return {index: BigInt(idx), root};
    }

    public async poolLimits(poolAddress: string, address: string | undefined): Promise<any> {
        let contract: ZkBobContractType;
        let contractAddress: string;
        if (await this.isMethodSupportedByContract(this.contractByType(ZkBobContractType.Pool), poolAddress, 'accounting')) {
            // Current contract deployments (getLimitsFor implemented in the separated ZkBobAccounting contract)
            let accountingAddress = this.accountingAddresses.get(poolAddress);
            if (!accountingAddress) {
                accountingAddress = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'accounting');
                if (accountingAddress) {
                    this.accountingAddresses.set(poolAddress, accountingAddress)
                } else {
                    throw new InternalError(`Cannot retrieve accounting contract address for the pool ${poolAddress}`);
                }
            }
            contract = ZkBobContractType.Accounting;
            contractAddress = accountingAddress;
        } else {
            // Fallback for the old deployments (getLimitsFor implemented in pool contract)
            contract = ZkBobContractType.Pool;
            contractAddress = poolAddress;
        }

        return await this.contractCallRetry(contract, contractAddress, 'getLimitsFor', [address ?? ZERO_ADDRESS1]);
    }

    public async isSupportForcedExit(poolAddress: string): Promise<boolean> {
        const poolContract = this.contractByType(ZkBobContractType.Pool);
        return this.isMethodSupportedByContract(poolContract, poolAddress, 'committedForcedExits', ['0']);
    }

    public async nullifierValue(poolAddress: string, nullifier: bigint): Promise<bigint> {
        const res = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'nullifiers', [nullifier]);
        
        return BigInt(res);
    }

    public async committedForcedExitHash(poolAddress: string, nullifier: bigint): Promise<bigint> {
        const res = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'committedForcedExits', [nullifier.toString()]);

        return BigInt(res);
    }

    public async createCommitForcedExitTx(poolAddress: string, forcedExit: ForcedExitRequest): Promise<PreparedTransaction> {
        const method = 'commitForcedExit(address,address,uint256,uint256,uint256,uint256,uint256[8])';
        const encodedTx = await this.contractByType(ZkBobContractType.Pool).methods[method](
            forcedExit.operator,
            forcedExit.to,
            forcedExit.amount.toString(),
            forcedExit.index,
            forcedExit.nullifier.toString(),
            forcedExit.out_commit.toString(),
            [forcedExit.tx_proof.a,
             forcedExit.tx_proof.b,
             forcedExit.tx_proof.c
            ].flat(2),
        ).encodeABI();

        return {
            to: poolAddress,
            amount: 0n,
            data: encodedTx,
        };
    }

    public async committedForcedExit(poolAddress: string, nullifier: bigint): Promise<CommittedForcedExit | undefined> {
        const pool = this.contractByType(ZkBobContractType.Pool);
        pool.options.address = poolAddress;

        const commitEventAbi = poolContractABI.find((val) => val.name == 'CommitForcedExit');
        const cancelEventAbi = poolContractABI.find((val) => val.name == 'CancelForcedExit');

        if (!commitEventAbi || !cancelEventAbi) {
            throw new InternalError('Could not find ABI items for forced exit events');
        }

        const commitSignature = this.activeWeb3().eth.abi.encodeEventSignature(commitEventAbi);
        const cancelSignature = this.activeWeb3().eth.abi.encodeEventSignature(cancelEventAbi);

        const associatedEvents = await this.activeWeb3().eth.getPastLogs({
            address: poolAddress,
            topics: [
                [commitSignature, cancelSignature],
                addHexPrefix(nullifier.toString(16).padStart(64, '0')),
            ],
            fromBlock: 0,
            toBlock: 'latest'
        });

        let result: CommittedForcedExit | undefined;
        associatedEvents
            .sort((e1, e2) => e1.blockNumber - e2.blockNumber)
            .forEach((e) => {
                switch (e.topics[0]) {
                    case commitSignature:
                        const decoded = this.activeWeb3().eth.abi.decodeLog(commitEventAbi.inputs ?? [], e.data, e.topics.slice(1))
                        result = {
                            nullifier: BigInt(decoded.nullifier),
                            operator: decoded.operator,
                            to: decoded.to,
                            amount: BigInt(decoded.amount),
                            exitStart: Number(decoded.exitStart),
                            exitEnd: Number(decoded.exitEnd),
                            txHash: e.transactionHash,
                        };
                        break;

                    case cancelSignature:
                        result = undefined;
                        break;
                }
            })

        return result;
    }

    public async executedForcedExit(poolAddress: string, nullifier: bigint): Promise<FinalizedForcedExit | undefined> {
        const pool = this.contractByType(ZkBobContractType.Pool);
        pool.options.address = poolAddress;

        const executeEventAbi = poolContractABI.find((val) => val.name == 'ForcedExit');

        if (!executeEventAbi) {
            throw new InternalError('Could not find ABI items for forced exit event');
        }

        const executeSignature = this.activeWeb3().eth.abi.encodeEventSignature(executeEventAbi);

        const associatedEvents = await this.activeWeb3().eth.getPastLogs({
            address: poolAddress,
            topics: [
                [executeSignature],
                null,
                addHexPrefix(nullifier.toString(16).padStart(64, '0')),
            ],
            fromBlock: 0,
            toBlock: 'latest'
        });

        if (associatedEvents.length > 0) {
            const decoded = this.activeWeb3().eth.abi.decodeLog(executeEventAbi.inputs ?? [], associatedEvents[0].data, associatedEvents[0].topics.slice(1))
            return {
                nullifier: BigInt(decoded.nullifier),
                to: decoded.to,
                amount: BigInt(decoded.amount),
                cancelled: false,
                txHash: associatedEvents[0].transactionHash,
            };
        }

        return undefined;
    }

    public async createExecuteForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction> {
        const method = 'executeForcedExit(uint256,address,address,uint256,uint256,uint256,bool)';
        const encodedTx = await this.contractByType(ZkBobContractType.Pool).methods[method](
            forcedExit.nullifier.toString(),
            forcedExit.operator,
            forcedExit.to,
            forcedExit.amount.toString(),
            forcedExit.exitStart,
            forcedExit.exitEnd,
            0
        ).encodeABI();

        return {
            to: poolAddress,
            amount: 0n,
            data: encodedTx,
        };
    }

    public async createCancelForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction> {
        const method = 'executeForcedExit(uint256,address,address,uint256,uint256,uint256,bool)';
        const encodedTx = await this.contractByType(ZkBobContractType.Pool).methods[method](
            forcedExit.nullifier.toString(),
            forcedExit.operator,
            forcedExit.to,
            forcedExit.amount.toString(),
            forcedExit.exitStart,
            forcedExit.exitEnd,
            1
        ).encodeABI();

        return {
            to: poolAddress,
            amount: 0n,
            data: encodedTx,
        };
    }

    public async getTokenSellerContract(poolAddress: string): Promise<string> {
        let tokenSellerAddr = this.tokenSellerAddresses.get(poolAddress);
        if (!tokenSellerAddr) {
            tokenSellerAddr = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'tokenSeller');
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
            ddContractAddr = await this.contractCallRetry(ZkBobContractType.Pool, poolAddress, 'direct_deposit_queue');
            if (ddContractAddr) {
                this.ddContractAddresses.set(poolAddress, ddContractAddr);
            } else {
                throw new InternalError(`Cannot fetch DD contract address`);
            }
        }

        return ddContractAddr;
    }

    public async getDirectDepositFee(ddQueueAddress: string): Promise<bigint> {
        const fee = await this.contractCallRetry(ZkBobContractType.DD, ddQueueAddress, 'directDepositFee');
        return BigInt(fee);
    }

    public async createDirectDepositTx(
        ddQueueAddress: string,
        amount: bigint,
        zkAddress: string,
        fallbackAddress: string,
    ): Promise<PreparedTransaction> {
        const zkAddrBytes = `0x${Buffer.from(bs58.decode(zkAddress.substring(zkAddress.indexOf(':') + 1))).toString('hex')}`;
        const encodedTx = await this.contractByType(ZkBobContractType.DD).methods["directDeposit(address,uint256,bytes)"](fallbackAddress, amount, zkAddrBytes).encodeABI();

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
        const encodedTx = await this.contractByType(ZkBobContractType.DD).methods["directNativeDeposit(address,bytes)"](fallbackAddress, zkAddrBytes).encodeABI();

        return {
            to: ddQueueAddress,
            amount: nativeAmount,
            data: encodedTx,
        };
    }

    public async getDirectDeposit(ddQueueAddress: string, idx: number, state: ZkBobState): Promise<DirectDeposit | undefined> {
        const ddInfo = await this.contractCallRetry(ZkBobContractType.DD, ddQueueAddress, 'getDirectDeposit', [idx]);
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
        const res = await this.contractCallRetry(ZkBobContractType.DD, ddQueueAddress, 'directDepositNonce');

        return Number(res);
    }


    // ------------------------=========< Signatures >=========-----------------------
    // | Signing and recovery [ECDSA]                                                |
    // -------------------------------------------------------------------------------

    public async sign(data: any, privKey: string): Promise<string> {
        let keyBuf = Buffer.from(hexToBuf(privKey));
        const signature = personalSign({
            privateKey: keyBuf,
            data: data,
        }); // canonical signature (65 bytes long, LSByte: 1b or 1c)
        keyBuf.fill(0);

        // EVM deployments use compact signatures
        return this.toCompactSignature(signature);
    }

    public async signTypedData(typedData: any, privKey: string): Promise<string> {
        let keyBuf = Buffer.from(hexToBuf(privKey));
        const signature = signTypedData({
            privateKey: keyBuf,
            data: typedData,
            version: SignTypedDataVersion.V4
        }); // canonical signature (65 bytes long, LSByte: 1b or 1c)
        keyBuf.fill(0);

        // EVM deployments use compact signatures
        return this.toCompactSignature(signature);
    }

    public async recoverSigner(data: any, signature: string): Promise<string> {
        const address = await recoverPersonalSignature({
            data: data,
            signature: this.toCanonicalSignature(signature)
        });

        return addHexPrefix(address);
    }

    public async recoverSignerTypedData(typedData: any, signature: string): Promise<string> {
        const address = await recoverTypedSignature({
            data: typedData,
            signature: this.toCanonicalSignature(signature),
            version: SignTypedDataVersion.V4
        });

        return addHexPrefix(address);
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
        // Validate a given address:
        //  - it should starts with '0x' prefix
        //  - it should be 20-byte length
        //  - if it contains checksum (EIP-55) it should be valid
        //  - zero addresses are prohibited to withdraw
        return isHexPrefixed(address) && isAddress(address) && address.toLowerCase() != ZERO_ADDRESS;
    }

    public addressFromPrivateKey(privKeyBytes: Uint8Array): string {
        const buf = Buffer.from(privKeyBytes);
        const address = bufferToHex(privateToAddress(buf));
        buf.fill(0);

        return address;
    }

    public addressToBytes(address: string): Uint8Array {
        return hexToBuf(address, 20);
    }

    public bytesToAddress(bytes: Uint8Array): string {
        return addHexPrefix(bufToHex(bytes));
    }

    public isEqualAddresses(addr1: string, addr2: string): boolean {
        return truncateHexPrefix(addr1).toLocaleLowerCase() == truncateHexPrefix(addr2).toLocaleLowerCase();
    }

    public txHashFromHexString(hexString: string): string {
        return addHexPrefix(hexString);
    }

    private async getTransaction(txHash: string): Promise<Transaction> {
        return this.commonRpcRetry(() => {
            return this.activeWeb3().eth.getTransaction(txHash);
        }, 'Cannot get tx');
    }

    private async getTransactionReceipt(txHash: string): Promise<TransactionReceipt> {
        return this.commonRpcRetry(() => {
            return this.activeWeb3().eth.getTransactionReceipt(txHash);
        }, 'Cannot get tx receipt');
    }

    public async getTxRevertReason(txHash: string): Promise<string | null> {
        const txReceipt = await this.getTransactionReceipt(txHash);
        if (txReceipt && txReceipt.status !== undefined) {
            if (txReceipt.status == false) {
                const txData = await this.getTransaction(txHash);                
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

    public async getChainId(): Promise<number> {
        return this.commonRpcRetry(async () => {
            return this.activeWeb3().eth.getChainId();
        }, 'Cannot get chain ID');
    }

    public async getNativeBalance(address: string): Promise<bigint> {
        return this.commonRpcRetry(async () => {
            return BigInt(await this.activeWeb3().eth.getBalance(address));
        }, 'Cannot get native balance');
    }

    public async getNativeNonce(address: string): Promise<number> {
        return this.commonRpcRetry(async () => {
            return Number(await this.activeWeb3().eth.getTransactionCount(address))
        }, 'Cannot get native nonce');
    }

    public async getTxDetails(index: number, poolTxHash: string, state: ZkBobState): Promise<PoolTxDetails | null> {
        try {
            const transactionObj = await this.getTransaction(poolTxHash);
            if (transactionObj && transactionObj.blockNumber && transactionObj.input) {
                const txData = truncateHexPrefix(transactionObj.input);
                const block = await this.activeWeb3().eth.getBlock(transactionObj.blockNumber).catch(() => null);
                if (block && block.timestamp) {
                    let timestamp: number = 0;
                    if (typeof block.timestamp === "number" ) {
                        timestamp = block.timestamp;
                    } else if (typeof block.timestamp === "string" ) {
                        timestamp = Number(block.timestamp);
                    }

                    let isMined = false;
                    const txReceipt = await this.getTransactionReceipt(poolTxHash);                    
                    if (txReceipt && txReceipt.status !== undefined && txReceipt.status == true) {
                        isMined = true;
                    }

                    const txSelector = txData.slice(0, 8).toLowerCase();
                    if (txSelector == PoolSelector.Transact || txSelector == PoolSelector.TransactV2) {
                        const txInfo = await parseTransactCalldata(txData, this);
                        txInfo.txHash = poolTxHash;
                        txInfo.isMined = isMined;
                        txInfo.timestamp = timestamp;
                        
                        return {
                            poolTxType: PoolTxType.Regular,
                            details: txInfo,
                            index,
                        };
                    } else if (txSelector == PoolSelector.AppendDirectDeposit || txSelector == PoolSelector.AppendDirectDepositV2) {
                        const ddQueue = await this.getDirectDepositQueueContract(transactionObj.to!)
                        const txInfo = await parseDirectDepositCalldata(txData, ddQueue, this, state);
                        txInfo.txHash = poolTxHash;
                        txInfo.isMined = isMined;
                        txInfo.timestamp = timestamp;

                        txInfo.deposits.forEach((aDeposit) => {
                            aDeposit.txHash = poolTxHash;
                            aDeposit.timestamp = timestamp;
                        })

                        return {
                            poolTxType: PoolTxType.DirectDepositBatch,
                            details: txInfo,
                            index,
                        };
                    } else {
                        throw new InternalError(`[EvmNetwork]: Cannot decode calldata for tx ${poolTxHash} (incorrect selector ${txSelector})`);
                    }
                } else {
                    console.warn(`[EvmNetwork]: cannot get block (${transactionObj.blockNumber}) to retrieve timestamp`);      
                }
            } else {
              console.warn(`[EvmNetwork]: cannot get native tx ${poolTxHash} (tx still not mined?)`);
            }
        } catch (err) {
            console.warn(`[EvmNetwork]: cannot get native tx ${poolTxHash} (${err.message})`);
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
            const [tx, receipt] = await Promise.all([
                this.activeWeb3().eth.getTransaction(txHash),
                this.activeWeb3().eth.getTransactionReceipt(txHash),
            ]);

            if (receipt) {
                if (receipt.status == true) {
                    return L1TxState.MinedSuccess;
                } else {
                    return L1TxState.MinedFailed;
                }
            }

            if (tx) {
                return L1TxState.Pending;
            }
        } catch(err) {
            console.warn(`[EvmNetwork] error on checking tx ${txHash}: ${err.message}`);
        }

        return L1TxState.NotFound;
    }

    public async abiDecodeParameters(abi: any, encodedParams: string): Promise<any> {
        return this.activeWeb3().eth.abi.decodeParameters(abi.inputs, encodedParams);
    }

    // ----------------------=========< Syncing >=========----------------------
    // | Getting block number, waiting for a block...                          |
    // -------------------------------------------------------------------------

    public async getBlockNumber(): Promise<number> {
        return this.commonRpcRetry(() => {
            return this.activeWeb3().eth.getBlockNumber();
        }, '[EvmNetwork]: Cannot get block number');
    }

    public async getBlockNumberFrom(rpcurl: string): Promise<number> {
        const tmpWeb3 = new Web3(rpcurl);
        return this.commonRpcRetry(() => {
            return tmpWeb3.eth.getBlockNumber();
        }, `[EvmNetwork]: Cannot get block number from ${rpcurl}`, true);
    }

    public async waitForBlock(blockNumber: number, timeoutSec?: number): Promise<boolean> {
        const startTime = Date.now();
        const SWITCH_RPC_DELAY = 30; // force switch RPC node after that time interval (in seconds)
        let curBlock: number;
        let waitMsgLogged = false;
        do {
            curBlock = await this.getBlockNumber().catch(() => 0);

            if (curBlock < blockNumber) {
                if (!waitMsgLogged) {
                    console.warn(`[EvmNetwork]: waiting for a block ${blockNumber} (current ${curBlock})...`);
                    waitMsgLogged = true;
                }

                if (Date.now() > startTime + SWITCH_RPC_DELAY * 1000) {
                    if (await this.switchToTheBestRPC()) {
                        console.warn(`[EvmNetwork]: RPC was auto switched because the block ${blockNumber} was not reached yet`);
                    }
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (Date.now() > startTime + (timeoutSec ?? Number.MAX_SAFE_INTEGER) * 1000) {
                console.warn(`[EvmNetwork]: timeout reached while waiting for a block ${blockNumber} (current block ${curBlock})`)
                return false;
            }
        } while(curBlock < blockNumber);

        if (waitMsgLogged) {
            console.log(`[EvmNetwork]: internal provider was synced with block ${blockNumber}`);
        }

        return true;
    }
}