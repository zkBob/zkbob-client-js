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
        name: 'nullifiers',
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
        inputs:[{
            internalType: 'address',
            name: '_user',
            type: 'address'
        }],
        name: 'getLimitsFor',
        outputs: [{
            components: [{
                internalType: 'uint256',
                name: 'tvlCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'tvl',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'depositCap',
                type: 'uint256'
            }, {
                internalType: 'uint8',
                name: 'tier',
                type: 'uint8'
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
            internalType: 'struct IZkBobAccounting.Limits',
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [],
        name: 'accounting',
        outputs: [{
            internalType: 'contract IZkBobAccounting',
            name: '',
            type: 'address'
        }],
        stateMutability: 'view',
        type: 'function'
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
    },
    {
        inputs: [{
            internalType: 'uint256',
            name: '_root_after',
            type: 'uint256'
        }, {
            internalType: 'uint256[]',
            name: '_indices',
            type: 'uint256[]'
        }, {
            internalType: 'uint256',
            name: '_out_commit',
            type: 'uint256'
        }, {
            internalType: 'uint256[8]',
            name: '_batch_deposit_proof',
            type: 'uint256[8]'
        }, {
            internalType: 'uint256[8]',
            name: '_tree_proof',
            type: 'uint256[8]'
        }],
        name: 'appendDirectDeposits',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'uint256[]',
            name: '_indices',
            type: 'uint256[]'
        }, {
            internalType: 'uint256',
            name: '_out_commit',
            type: 'uint256'
        }, {
            internalType: 'uint256[8]',
            name: '_batch_deposit_proof',
            type: 'uint256[8]'
        }, {
            internalType: 'address',
            name: '_prover',
            type: 'address'
        }],
        name: 'appendDirectDeposits',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            internalType: 'uint256',
            name: 'nullifier',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'address',
            name: 'operator',
            type: 'address'
        }, {
            indexed: false,
            internalType: 'address',
            name: 'to',
            type: 'address'
        }, {
            indexed: false,
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'uint256',
            name: 'exitStart',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'uint256',
            name: 'exitEnd',
            type: 'uint256'
        }],
        name: 'CommitForcedExit',
        type: 'event'
    },
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            internalType: 'uint256',
            name: 'nullifier',
            type: 'uint256'
        }],
        name: 'CancelForcedExit',
        type: 'event'
    },
    {
        inputs: [{
            internalType: 'uint256',
            name: '',
            type: 'uint256'
        }],
        name: 'committedForcedExits',
        outputs: [{
            internalType: 'bytes32',
            name: '',
            type: 'bytes32'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'address',
            name: '_operator',
            type: 'address'
        }, {
            internalType: 'address',
            name: '_to',
            type: 'address'
        }, {
            internalType: 'uint256',
            name: '_amount',
            type: 'uint256'
        }, {
            internalType: 'uint256',
            name: '_index',
            type: 'uint256'
        }, {
            internalType: 'uint256',
            name: '_nullifier',
            type: 'uint256'
        }, {
            internalType: 'uint256',
            name: '_out_commit',
            type: 'uint256'
        }, {
            internalType: 'uint256[8]',
            name: '_transfer_proof',
            type: 'uint256[8]'
        }],
        name: 'commitForcedExit',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            internalType: 'uint256',
            name: 'index',
            type: 'uint256'
        }, {
            indexed: true,
            internalType: 'uint256',
            name: 'nullifier',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'address',
            name: 'to',
            type: 'address'
        }, {
            indexed: false,
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256'
        }],
        name: 'ForcedExit',
        type: 'event'
    },
    {
        inputs: [{
            internalType: 'uint256',
            name: '_nullifier',
            type: 'uint256'
        }, {
            internalType: 'address',
            name: '_operator',
            type: 'address'
        }, {
            internalType: 'address',
            name: '_to',
            type: 'address'
        }, {
            internalType: 'uint256',
            name: '_amount',
            type: 'uint256'
        }, {
            internalType: 'uint256',
            name: '_exitStart',
            type: 'uint256'
        }, {
            internalType: 'uint256',
            name: '_exitEnd',
            type: 'uint256'
        }, {
            internalType: 'bool',
            name: '_cancel',
            type: 'bool'
        }],
        name: 'executeForcedExit',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
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
        inputs: [],
        name: 'directDepositNonce',
        outputs: [{
            internalType: 'uint32',
            name: '',
            type: 'uint32'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{
            internalType: 'uint256',
            name: '_index',
            type: 'uint256'
        }],
        name: 'getDirectDeposit',
        outputs: [{
            components: [{
                internalType: 'address',
                name: 'fallbackReceiver',
                type: 'address'
            }, {
                internalType: 'uint96',
                name: 'sent',
                type: 'uint96'
            }, {
                internalType: 'uint64',
                name: 'deposit',
                type: 'uint64'
            }, {
                internalType: 'uint64',
                name: 'fee',
                type: 'uint64'
            }, {
                internalType: 'uint40',
                name: 'timestamp',
                type: 'uint40'
            }, {
                internalType: 'enum IZkBobDirectDeposits.DirectDepositStatus',
                name: 'status',
                type: 'uint8'
            }, {
                internalType: 'bytes10',
                name: 'diversifier',
                type: 'bytes10'
            }, {
                internalType: 'bytes32',
                name: 'pk',
                type: 'bytes32'
            }],
            internalType: 'struct IZkBobDirectDeposits.DirectDeposit',
            name: '',
            type: 'tuple'
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
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            internalType: 'address',
            name: 'sender',
            type: 'address'
        }, {
            indexed: true,
            internalType: 'uint256',
            name: 'nonce',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'address',
            name: 'fallbackUser',
            type: 'address'
        }, {
            components: [{
                internalType: 'bytes10',
                name: 'diversifier',
                type: 'bytes10'
            }, {
                internalType: 'bytes32',
                name: 'pk',
                type: 'bytes32'
            }],
            indexed: false,
            internalType: 'struct ZkAddress.ZkAddress',
            name: 'zkAddress',
            type: 'tuple'
        }, {
            indexed: false,
            internalType: 'uint64',
            name: 'deposit',
            type: 'uint64'
        }],
        name: 'SubmitDirectDeposit',
        type: 'event'
    },
    {
        anonymous: false,
        inputs: [{
            indexed: false,
            internalType: 'uint256[]',
            name: 'indices',
            type: 'uint256[]'
        }],
        name: 'CompleteDirectDepositBatch',
        type: 'event'
    },
    {
        anonymous: false,
        inputs: [{
            indexed: true,
            internalType: 'uint256',
            name: 'nonce',
            type: 'uint256'
        }, {
            indexed: false,
            internalType: 'address',
            name: 'receiver',
            type: 'address'
        }, {
            indexed: false,
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256'
        }],
        name: 'RefundDirectDeposit',
        type: 'event'
    },
];

export const accountingABI: AbiItem[] = [
    {
        inputs:[{
            internalType: 'address',
            name: '_user',
            type: 'address'
        }],
        name: 'getLimitsFor',
        outputs: [{
            components: [{
                internalType: 'uint256',
                name: 'tvlCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'tvl',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyDepositCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyWithdrawalCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCap',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'dailyUserDepositCapUsage',
                type: 'uint256'
            }, {
                internalType: 'uint256',
                name: 'depositCap',
                type: 'uint256'
            }, {
                internalType: 'uint8',
                name: 'tier',
                type: 'uint8'
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
            internalType: 'struct IZkBobAccounting.Limits',
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
];