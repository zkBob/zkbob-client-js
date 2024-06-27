import { ZkAddressPrefix } from "./config"

export const GENERIC_ADDRESS_PREFIX = 'zkbob';
export const PREFIXED_ADDR_REGEX: RegExp = /^[a-zA-Z][a-zA-Z0-9+_\-\,@&]+:([1-9A-HJ-NP-Za-km-z]{62,63})$/;
export const NAKED_ADDR_REGEX: RegExp = /^([1-9A-HJ-NP-Za-km-z]{62,63})$/;


export const hardcodedPrefixes: ZkAddressPrefix[] = [
    // Production address prefixes
    {
        poolId: 0x000000,
        prefix: 'zkbob_polygon',
        name: 'USDC on Polygon'
    },
    {
        poolId: 0x000001,
        prefix: 'zkbob_optimism',
        name: 'USDC on Optimism'
    },
    {
        poolId: 0x000002,
        prefix: 'zkbob_optimism_eth',
        name: 'WETH on Optimism'
    },
    {
        poolId: 0x000003,
        prefix: 'zkbob_tron',
        name: 'USDT on Tron'
    },
    // Staging address prefixes
    {
        poolId: 0x000000,
        prefix: 'zkbob_sepold',
        name: 'BOB on Sepolia testnet [the first dev pool, deprecated]'
    },
    {
        poolId: 0xffff02,
        prefix: 'zkbob_goerli',
        name: 'BOB on Goerli testnet'
    },
    {
        poolId: 0xffff03,
        prefix: 'zkbob_goerli_optimism',
        name: 'BOB on Goerli Optimism testnet'
    },
    {
        poolId: 0xffff04,
        prefix: 'zkbob_goerli_eth',
        name: 'WETH on Goerli testnet'
    },
    {
        poolId: 0xffff05,
        prefix: 'zkbob_goerli_usdc',
        name: 'USDC on Goerli testnet'
    },
    {
        poolId: 0xffff06,
        prefix: 'zkbob_shasta',
        name: 'USDT on Shasta testnet'
    },
    {
        poolId: 0xffff07,
        prefix: 'zkbob_nile',
        name: 'USDT on Nile testnet'
    },
];