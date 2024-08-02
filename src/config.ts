import { TxCalldataVersion } from "./tx";
import { bufToHex } from "./utils";
import { hash } from 'tweetnacl';

export interface SnarkConfigParams {
  transferParamsUrl: string;
  transferVkUrl: string;
}

export interface Chain {
  rpcUrls: string[];
}

export type Chains = {
  [chainId: string]: Chain;
};

export type Pools = {
  [name: string]: Pool;
};

export type Parameters = {
  [name: string]: SnarkConfigParams;
}

export enum DepositType {
  Approve = 'approve',  // deprecated but still supported deposit scheme
  SaltedPermit = 'permit',  // based on EIP-2612 (salt was added to the signing message)
  PermitV2 = 'permit2',   // Uniswap Permit2 scheme (used for WETH)
  AuthUSDC = 'usdc',   // EIP-3009 (for most of USDC deployments)
  AuthPolygonUSDC = 'usdc-polygon',  // EIP-3009 (used by USDC.e token on Polygon)
}

export interface Pool {
  chainId: number;
  poolAddress: string;
  tokenAddress: string,
  depositScheme: DepositType;
  relayerUrls?: string[];
  proxyUrls?: string[];
  delegatedProverUrls?: string[];
  coldStorageConfigPath?: string;
  minTxAmount?: bigint;
  feeDecimals?: number;
  isNative?: boolean;
  ddSubgraph?: string;
  parameters?: string;
}

export enum ProverMode {
  Local = "Local",
  Delegated = "Delegated",
  DelegatedWithFallback = "DelegatedWithFallback"
}

export interface ClientConfig {
  // A map of supported pools (pool name => pool params)
  pools: Pools;
  // A map of supported chains (chain id => chain params)
  chains: Chains;
  // URLs for params and verification keys:
  // pools without 'parameters' field assumed to use that params
  snarkParams?: SnarkConfigParams;
  // Separated parameters for different pools are also supported:
  //  - the `Pool` object can contain the params name from that set
  //    in the 'parameters' optional fields
  //  - you can combine snarkParams (as global ones) 
  //    with snarkParamsSet (as custom for the specified pools)
  //  - you MUST define at least snarkParams or snarkParamsSet in the config
  //    otherwise the error will thrown during the client initialization
  snarkParamsSet?: Parameters;
  // Support ID - unique random string to track user's activity for support purposes
  supportId?: string;
  // By default MT mode selects automatically depended on browser
  // This flag can override autoselection behaviour
  forcedMultithreading?: boolean;
  // Additional shielded address prefixes. You can use it to introduce new pools
  // The shielded address checksum depends on the associated pool ID
  // So this structures needed to check is address valid
  // These prefixes should not conflict with the hardcoded ones (otherwise it will ignored)
  extraPrefixes?: ZkAddressPrefix[];
}

export interface AccountConfig {
  // Spending key for the account
  sk: Uint8Array;
  // Initial (current) pool alias (e.g. 'USDC-Polygon' or 'BOB-Sepolia')
  // The pool can be switched later without logout
  pool: string;
  // Account birthday for selected pool
  //  no transactions associated with the account should exist lower that index
  //  set -1 to use the latest index (ONLY for creating _NEW_ account)
  birthindex?: number;
  // Current prover mode (local, delegated, delegated with fallback)
  proverMode: ProverMode;
}

export interface ZkAddressPrefix {
  poolId: number;
  prefix: string;
  name?: string;
}

// Create account unique ID based on the pool and spending key
export function accountId(acc: AccountConfig): string {
  const userId = bufToHex(hash(acc.sk)).slice(0, 32);
  return `${acc.pool}.${userId}`;
}
