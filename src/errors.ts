import { ServiceType } from "./services/common";
import { SequencerJob } from "./services/relayer";

export class BobError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        if (Error.captureStackTrace !== undefined) {
            Error.captureStackTrace(this);
        }
    }
}

export class InternalError extends BobError {
    constructor(message: string) {
        super(message);
    }
}

export class TxSmallAmount extends BobError {
    constructor(public amount: bigint, public minAmount: bigint) {
        super(`Transaction amount is too small (${amount.toString()} < ${minAmount.toString()})`);
    }
}

export class TxLimitError extends BobError {
    constructor(public amount: bigint, public limitAvailable: bigint) {
        super(`Transaction exceed current limit (${amount.toString()} > ${limitAvailable.toString()})`);
    }
}

export class TxProofError extends BobError {
    constructor() {
        super(`Transaction proof incorrect`);
    }
}

export class TxInvalidArgumentError extends BobError {
    constructor(message: string) {
        super(message);
    }
}

export class SignatureError extends BobError {
    constructor(public message: string) {
        super(message);
    }
}

export class TxDepositDeadlineExpiredError extends BobError {
    constructor(public deadline: number) {
        super(`Deposit permit deadline is about to be expired`);
    }
}

export class TxDepositAllowanceTooLow extends BobError {
    constructor(public needed: bigint, public current: bigint, public spender: string) {
        super(`Token allowance for ${spender} is too low (needed ${needed.toString()}, current ${current.toString()})`);
    }
}

export class TxDepositNonceAlreadyUsed extends BobError {
    constructor(public nonce: string, public contract: string) {
        super(`Nonce ${nonce} already used on contract ${contract}`);
    }
}

export class TxInsufficientFundsError extends BobError {
    constructor(public needed: bigint, public available: bigint) {
        super(`Insufficient funds for transaction (needed ${needed.toString()}, available ${available.toString()})`);
    }
}

export class TxSwapTooHighError extends BobError {
    constructor(public requested: bigint, public supported: bigint) {
        super(`The pool doesn't support requested swap amount (requested ${requested.toString()}, supported ${supported.toString()})`);
    }
}

export class TxAccountDeadError extends BobError {
    constructor() {
        super('The account cannot transact or receive funds anymore due to executed forced exit');
    }
}

export class TxAccountLocked extends BobError {
    constructor(public upto: Date) {
        super(`The account was locked for emergency exit up to ${upto.toLocaleString()}`);
    }
}

export class ServiceError extends BobError {
    constructor(public service: ServiceType, public code: number, public message: string) {
        super(`${service} response incorrect (code ${code}): ${message}`);
    }
}

export class NetworkError extends BobError {
    constructor(public cause?: Error, public host?: string) {
        super(`Unable connect to the host ${host !== undefined ? host : ''} (${cause?.message})`);
    }
}

export class RelayerJobError extends BobError {
    constructor(public job: SequencerJob, public reason: string) {
        super(`Job ${job.toString()} failed with reason: ${reason}`);
    }
}

export class PoolJobError extends BobError {
    constructor(public job: SequencerJob, public txHash: string, public reason: string) {
        super(`Tx ${txHash} (job ${job.toString()}) was reverted on the contract with reason: ${reason}`);
    }
}

export class ZkAddressParseError extends BobError {s
    constructor(public description: string) {
        super(`Address parse error: ${description}`);
    }
}
