import { ZkBobState } from "../state";
import { EvmNetwork, InternalError, TxType } from "..";
import { DirectDeposit, PoolTxDetails, TxCalldataVersion } from "../tx";
import { TronNetwork } from "./tron";
import { CommittedForcedExit, FinalizedForcedExit, ForcedExitRequest } from "../emergency";

export interface PreparedTransaction {
    to: string;
    amount: bigint;
    data: string;
    selector?: string;
}

export enum L1TxState {
    NotFound,
    Pending,
    MinedSuccess,
    MinedFailed,
}

export interface NetworkBackend {
    // Backend Maintenance
    isEnabled(): boolean;
    setEnabled(enabled: boolean);

    // Token 
    getTokenName(tokenAddress: string): Promise<string>;
    getTokenDecimals(tokenAddress: string): Promise<number>;
    getDomainSeparator(tokenAddress: string): Promise<string>;
    getTokenNonce(tokenAddress: string, address: string): Promise<number>;
    getTokenBalance(tokenAddress: string, address: string): Promise<bigint>;
    allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint>;
    permit2NonceBitmap(permit2Address: string, owner: string, wordPos: bigint): Promise<bigint>;
    erc3009AuthState(tokenAddress: string, authorizer: string, nonce: bigint): Promise<bigint>;
    approveTokens(tokenAddress: string, privateKey: string, holder: string, spender: string, amount: bigint, gasFactor?: number): Promise<string>
    isSupportNonce(tokenAddres: string): Promise<boolean>;

    // Pool Interaction
    getPoolId(poolAddress: string): Promise<number>;
    getDenominator(poolAddress: string): Promise<bigint>;
    poolState(poolAddress: string, index?: bigint): Promise<{index: bigint, root: bigint}>;
    poolLimits(poolAddress: string, address: string | undefined): Promise<any>;
    isSupportForcedExit(poolAddress: string): Promise<boolean>;
    nullifierValue(poolAddress: string, nullifier: bigint): Promise<bigint>;
    committedForcedExitHash(poolAddress: string, nullifier: bigint): Promise<bigint>;
    createCommitForcedExitTx(poolAddress: string, forcedExit: ForcedExitRequest): Promise<PreparedTransaction>;
    committedForcedExit(poolAddress: string, nullifier: bigint): Promise<CommittedForcedExit | undefined>;
    executedForcedExit(poolAddress: string, nullifier: bigint): Promise<FinalizedForcedExit | undefined>;
    createExecuteForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction>;
    createCancelForcedExitTx(poolAddress: string, forcedExit: CommittedForcedExit): Promise<PreparedTransaction>;
    getTokenSellerContract(poolAddress: string): Promise<string>;

    // Direct Deposits
    getDirectDepositQueueContract(poolAddress: string): Promise<string>;
    getDirectDepositFee(ddQueueAddress: string): Promise<bigint>;
    getDirectDeposit(ddQueueAddress: string, idx: number, state: ZkBobState): Promise<DirectDeposit | undefined>;
    getDirectDepositNonce(ddQueueAddress: string): Promise<number>;
    createDirectDepositTx(ddQueueAddress: string, amount: bigint, zkAddress: string, fallbackAddress: string): Promise<PreparedTransaction>;
    createNativeDirectDepositTx(ddQueueAddress: string, nativeAmount: bigint, zkAddress: string, fallbackAddress: string): Promise<PreparedTransaction>;

    // Signatures
    sign(data: any, privKey: string): Promise<string>;
    signTypedData(typedData: any, privKey: string): Promise<string>;
    recoverSigner(data: any, signature: string): Promise<string>;
    recoverSignerTypedData(typedData: any, signature: string): Promise<string>;
    toCompactSignature(signature: string): string;
    toCanonicalSignature(signature: string): string;

    // Miscellaneous
    validateAddress(address: string): boolean;
    addressFromPrivateKey(privKeyBytes: Uint8Array): string;
    addressToBytes(address: string): Uint8Array;
    bytesToAddress(bytes: Uint8Array): string;
    isEqualAddresses(addr1: string, addr2: string): boolean;
    txHashFromHexString(hexString: string): string;
    getTxRevertReason(txHash: string): Promise<string | null>
    getChainId(): Promise<number>;
    getNativeBalance(address: string): Promise<bigint>;
    getNativeNonce(address: string): Promise<number>;
    getTxDetails(index: number, poolTxHash: string, state: ZkBobState): Promise<PoolTxDetails | null>;
    calldataBaseLength(ver: TxCalldataVersion): number;
    estimateCalldataLength(ver: TxCalldataVersion, txType: TxType, notesCnt: number, extraDataLen: number): number;
    getTransactionState(txHash: string): Promise<L1TxState>;
    abiDecodeParameters(abi: any, encodedParams: string): Promise<any>;

    // syncing with external providers
    getBlockNumber(): Promise<number>;
    waitForBlock(blockNumber: number, timeoutSec?: number): Promise<boolean>;
}


enum SupportedNetwork {
    EvmNetwork,
    TronNetwork,
}

function networkType(chainId: number): SupportedNetwork | undefined {
    if ([0x2b6653dc, 0x94a9059e, 0xcd8690dc].includes(chainId)) {
        return SupportedNetwork.TronNetwork;
    } else if ([1, 137, 10, 11155111, 5, 420, 1337, 31337].includes(chainId)) {
        return SupportedNetwork.EvmNetwork;
    }

    return undefined;
}


export class NetworkBackendFactory {
    static createBackend(chainId: number, rpcUrls: string[], enabled: boolean = true): NetworkBackend {
        const type = networkType(chainId);
        switch (type) {
            case SupportedNetwork.TronNetwork:
                return new TronNetwork(rpcUrls, enabled);

            case undefined:
                console.warn(`[NetworkBackendFactory] Unknown chain id provided (${chainId}). Assume it's an EVM network...`)
            case SupportedNetwork.EvmNetwork: 
                return new EvmNetwork(rpcUrls, enabled);

            default:
                throw new Error(`Unknown network type ${type}`);
        }
    }
}