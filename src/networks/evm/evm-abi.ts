import { AbiItem } from 'web3-utils';

export const tokenABI: AbiItem[] = [
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            name: 'from',
            type: 'address'
        }, {
            indexed: true,
            name: 'to',
            type: 'address'
        }, {
            indexed: false,
            name: 'value',
            type: 'uint256'
        }],
        name: 'Transfer',
        type: 'event'
    }, {
        inputs: [],
        name: 'name',
        outputs: [{
            internalType: 'string',
            name: '',
            type: 'string'
        }],
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [],
        name: 'decimals',
        outputs: [{
            internalType: 'uint8',
            name: '',
            type: 'uint8'
        }],
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [{
            internalType: 'address',
            name: '',
            type: 'address'
        }],
        name: 'nonces',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'view',
        type: 'function'
    }, {
        constant: true,
        inputs: [{
            name: '_owner',
            type: 'address'
        }],
        name: 'balanceOf',
        outputs: [{
            name: 'balance',
            type: 'uint256'
        }],
        payable: false,
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [
          {
            internalType: 'address',
            name: '',
            type: 'address'
          },
          {
            internalType: 'address',
            name: '',
            type: 'address'
          }
        ],
        name: 'allowance',
        outputs: [
          {
            internalType: 'uint256',
            name: '',
            type: 'uint256'
          }
        ],
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [{
            internalType: 'address',
            name: 'spender',
            type: 'address'
          }, {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256'
          }],
        name: 'approve',
        outputs: [{
            internalType: 'bool',
            name: '',
            type: 'bool'
        }],
        stateMutability: 'nonpayable',
        type: 'function'
    }, {
        inputs: [{ 
            internalType: 'address',
            name: '',
            type: 'address'
        }, {
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        name: 'nonceBitmap',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [{
            internalType: 'address',
            name: 'authorizer',
            type: 'address'
        }, {
            internalType: 'bytes32',
            name: 'nonce',
            type: 'bytes32'
        }],
        name: 'authorizationState',
        outputs: [{
            internalType: 'uin256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'view',
        type: 'function'
    }, {
        inputs: [],
        stateMutability: 'view',
        type: 'function',
        name: 'DOMAIN_SEPARATOR',
        outputs: [{
            internalType: 'bytes32',
            name: '',
            type: 'bytes32',
        }],
    },
];

export const poolContractABI: AbiItem[] = [
    {
        constant: true,
        inputs: [],
        name: 'denominator',
        outputs: [{
            name: '',
            type: 'uint256',
        }],
        stateMutability: 'pure',
        type: 'function',
    },
    {
        inputs: [],
        name: 'pool_id',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256',
        }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs:[],
        name: 'pool_index',
        outputs: [{
            internalType: 'uint256',
            name:'',
            type:'uint256'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        name: 'roots',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'address',
            name: '_user',
            type: 'address',
        }],
        name: 'getLimitsFor',
        outputs: [{
            components: [{
                internalType: 'uint256',
                name: 'tvlCap',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'tvl',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCap',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCapUsage',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCap',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCapUsage',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCap',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCapUsage',
                type: 'uint256',
            }, {
                internalType: 'uint256',
                name: 'depositCap',
                type: 'uint256',
            }, {
                internalType: 'uint8',
                name: 'tier',
                type: 'uint8',
            }, {
                internalType: 'uint256',
                name: 'dailyUserDirectDepositCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyUserDirectDepositCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'directDepositCap',
                type: 'uint256'
            }],
            internalType: 'struct ZkBobAccounting.Limits',
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'direct_deposit_queue',
        outputs: [{
            internalType: 'contract IZkBobDirectDepositQueue',
            name: '',
            type: 'address'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [],
        name: 'tokenSeller',
        outputs: [{
            internalType: 'contract ITokenSeller',
            name: '',
            type: 'address'
        }],
        stateMutability: 'view',
        type: 'function'
    }
];

export const ddContractABI: AbiItem[] = [
    {
        inputs: [],
        name: 'directDepositFee',
        outputs: [{
            internalType: 'uint64',
            name: '',
            type: 'uint64'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'address',
            name: '_fallbackUser',
            type: 'address'
        }, {
            internalType: 'uint256',
            name: '_amount',
            type: 'uint256'
        }, {
            internalType: 'bytes',
            name: '_rawZkAddress',
            type: 'bytes'
        }],
        name: 'directDeposit',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [ {
            internalType: 'address',
            name: '_fallbackUser',
            type: 'address'
        }, {
            internalType: 'bytes',
            name: '_rawZkAddress',
            type: 'bytes'
        }],
        name: 'directNativeDeposit',
        outputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        stateMutability: 'payable',
        type: 'function'
    },
];