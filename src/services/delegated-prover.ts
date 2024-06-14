import { SecretData } from "kalypso-sdk/dist/types";
import { InternalError, ServiceError } from "../errors";
import {
  IZkBobService,
  ServiceType,
  ServiceVersion,
  isServiceVersion,
  ServiceVersionFetch,
  defaultHeaders,
  fetchJson,
} from "./common";
import { KalypsoSdk } from "kalypso-sdk";

const PROVER_VERSION_REQUEST_THRESHOLD = 3600; // prover's version expiration (in seconds)

export class ZkBobDelegatedProver implements IZkBobService {
  private proverUrls: string[];
  // TODO: implement proper prover swiching / fallbacking
  private curIdx: number;
  private supportId: string | undefined;
  private proverVersions = new Map<string, ServiceVersionFetch>(); // prover version: URL -> version
  private proverPubKey: string;

  public static create(
    proverUrls: string[],
    supportId: string | undefined,
  ): ZkBobDelegatedProver {
    if (proverUrls.length == 0) {
      throw new InternalError(
        "ZkBobDelegatedProver: you should provide almost one delegated prover url",
      );
    }

    const object = new ZkBobDelegatedProver();

    object.proverUrls = proverUrls;
    object.supportId = supportId;
    object.curIdx = 0;
    object.proverPubKey =
      "04e84450db2948a8efd92fa52342fff3c3286189ca62efde1f8d96ba733247a3080d944e29f2f206d44533afc5523422f492f92fa9140e7bac48740dbb46300e45";

    return object;
  }

  // ------------------=========< IZkBobService Methods >=========------------------
  // | Mandatory universal service routines                                        |
  // -------------------------------------------------------------------------------

  public type(): ServiceType {
    return ServiceType.DelegatedProver;
  }

  public async version(): Promise<ServiceVersion> {
    const proverUrl = this.url();

    let cachedVer = this.proverVersions.get(proverUrl);
    if (
      cachedVer === undefined ||
      cachedVer.timestamp + PROVER_VERSION_REQUEST_THRESHOLD * 1000 < Date.now()
    ) {
      const url = new URL(`/version`, proverUrl);
      const headers = defaultHeaders();

      const version = await fetchJson(url.toString(), { headers }, this.type());
      if (isServiceVersion(version) == false) {
        throw new ServiceError(
          this.type(),
          200,
          `Incorrect response (expected ServiceVersion, got \'${version}\')`,
        );
      }

      cachedVer = { version, timestamp: Date.now() };
      this.proverVersions.set(proverUrl, cachedVer);
    }

    return cachedVer.version;
  }

  public url(): string {
    return this.proverUrls[this.curIdx];
  }

  public async healthcheck(): Promise<boolean> {
    try {
      const url = new URL(`/version`, this.url());
      const headers = defaultHeaders();

      const version = await fetchJson(url.toString(), { headers }, this.type());
      return isServiceVersion(version);
    } catch {
      return false;
    }
  }

  // ------------=========< Delegated Prover Specific Routines >=========------------
  // |                                                                              |
  // --------------------------------------------------------------------------------

  public async proveTx(pub: any, sec: any): Promise<any> {
    console.log("delegated prover proveTx");

    console.log("plain text data");

    console.log({ pub: pub, sec: sec });
    const encryptionResult: SecretData =
      await KalypsoSdk.SecretInputOperations().encryptDataWithECIESandAES(
        Buffer.from(JSON.stringify(sec)),
        this.proverPubKey,
      );
    // const secretInputs = JSON.stringify(encryptionResult.encryptedData);
    const body = JSON.stringify({
      ...pub,
      ...encryptionResult,
    });

    console.log("using encryption key", this.proverPubKey);
    console.log("encrypted request");

    console.log(body);
    const url = new URL("/proveTx", this.url());

    const proof = await fetchJson(
      url.toString(),
      {
        method: "POST",
        body,
        headers: [["Content-type", "application/json"]],
      },
      ServiceType.DelegatedProver,
    );

    return proof;
  }
}
