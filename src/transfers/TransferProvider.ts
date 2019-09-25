import queryString from "query-string";

import {
  DepositInfo,
  Fee,
  FeeArgs,
  Info,
  RawInfoResponse,
  SimpleFee,
  Transaction,
  TransactionArgs,
  TransactionsArgs,
  TransactionStatus,
  WatchTransactionArgs,
  WithdrawInfo,
} from "../types";

import { parseInfo } from "./parseInfo";

/**
 * TransferProvider is the base class for WithdrawProvider and DepositProvider.
 */
export abstract class TransferProvider {
  public transferServer: string;
  public operation: "deposit" | "withdraw";
  public account: string;
  public info?: Info;
  public authToken?: string;

  protected _transactionWatcher?: number;

  constructor(
    transferServer: string,
    account: string,
    operation: "deposit" | "withdraw",
  ) {
    if (!transferServer) {
      throw new Error("Required parameter `transferServer` missing!");
    }

    if (!account) {
      throw new Error("Required parameter `account` missing!");
    }

    if (!operation) {
      throw new Error("Required parameter `operation` missing!");
    }

    this.transferServer = transferServer;
    this.operation = operation;
    this.account = account;
  }

  protected async fetchInfo(): Promise<Info> {
    const response = await fetch(`${this.transferServer}/info`);
    const rawInfo = (await response.json()) as RawInfoResponse;
    const info = parseInfo(rawInfo);
    this.info = info;
    return info;
  }

  protected getHeaders(): Headers {
    return new Headers(
      this.authToken
        ? {
            Authorization: `Bearer ${this.authToken}`,
          }
        : {},
    );
  }

  /**
   * Set the bearer token fetched by KeyManager's fetchAuthToken function.
   * (setAuthToken and fetchAuthToken are in two different classes because
   * fetchAuthToken requires signing keys, which requires KeyManager's helpers.)
   */
  public setAuthToken(token: string) {
    this.authToken = token;
  }

  public abstract fetchSupportedAssets():
    | Promise<WithdrawInfo>
    | Promise<DepositInfo>;

  /**
   * Fetch the list of transactions for a given account / asset code from the
   * transfer server.
   */
  public async fetchTransactions(
    args: TransactionsArgs,
  ): Promise<Transaction[]> {
    const isAuthRequired = this.getAuthStatus(
      "fetchTransactions",
      args.asset_code,
    );

    const response = await fetch(
      `${this.transferServer}/transactions?${queryString.stringify(
        args as any,
      )}`,
      {
        headers: isAuthRequired ? this.getHeaders() : undefined,
      },
    );

    const { transactions } = await response.json();

    return transactions.filter(
      (transaction: Transaction) =>
        args.show_all_transactions ||
        (this.operation === "deposit" && transaction.kind === "deposit") ||
        (this.operation === "withdraw" && transaction.kind === "withdrawal"),
    ) as Transaction[];
  }

  /**
   * Fetch the information of a single transaction from the transfer server.
   */
  public async fetchTransaction(
    { asset_code, id }: TransactionArgs,
    isWatching: boolean,
  ): Promise<Transaction> {
    const isAuthRequired = this.getAuthStatus(
      isWatching ? "watchTransaction" : "fetchTransaction",
      asset_code,
    );

    const response = await fetch(
      `${this.transferServer}/transaction?${queryString.stringify({ id })}`,
      {
        headers: isAuthRequired ? this.getHeaders() : undefined,
      },
    );

    const transaction: Transaction = await response.json();

    return transaction;
  }

  /**
   * Watch a transaction until it stops pending. Takes three callbacks:
   * * onMessage - When the transaction comes back as pending.
   * * onSuccess - When the transaction comes back as completed.
   * * onError - When there's a runtime error, or the transaction is incomplete
   * / no_market / too_small / too_large / error.
   */
  public watchTransaction({
    asset_code,
    id,
    onMessage,
    onSuccess,
    onError,
    timeout = 5000,
  }: WatchTransactionArgs): () => void {
    this._transactionWatcher = setTimeout(async () => {
      try {
        const transaction = await this.fetchTransaction(
          { asset_code, id },
          true,
        );

        if (transaction.status.indexOf("pending") === 0) {
          this.watchTransaction({
            asset_code,
            id,
            onMessage,
            onSuccess,
            onError,
            timeout,
          });
          onMessage(transaction);
        } else if (transaction.status === TransactionStatus.completed) {
          onSuccess(transaction);
        } else {
          onError(transaction);
        }
      } catch (e) {
        onError(e);
      }
    }, 1000) as any;

    return () => {
      clearTimeout(this._transactionWatcher);
    };
  }

  public async fetchFinalFee(args: FeeArgs): Promise<number> {
    if (!this.info || !this.info[this.operation]) {
      throw new Error("Run fetchSupportedAssets before running fetchFinalFee!");
    }

    const assetInfo = this.info[this.operation][args.asset_code];

    if (!assetInfo) {
      throw new Error(
        `Can't get fee for an unsupported asset, '${args.asset_code}`,
      );
    }
    const { fee } = assetInfo;
    switch (fee.type) {
      case "none":
        return 0;
      case "simple":
        const simpleFee = fee as SimpleFee;
        return (
          ((simpleFee.percent || 0) / 100) * Number(args.amount) +
          (simpleFee.fixed || 0)
        );
      case "complex":
        const response = await fetch(
          `${this.transferServer}/fee?${queryString.stringify(args as any)}`,
        );
        const { fee: feeResponse } = await response.json();
        return feeResponse as number;

      default:
        throw new Error(
          `Invalid fee type found! Got '${
            (fee as Fee).type
          }' but expected one of 'none', 'simple', 'complex'`,
        );
    }
  }

  /**
   * Return whether or not auth is required on a token. Throw an error if no
   * asset_code or account was provided, or supported assets weren't fetched,
   * or the asset isn't supported by the transfer server.
   */
  protected getAuthStatus(functionName: string, asset_code: string): boolean {
    if (!asset_code) {
      throw new Error("Required parameter `asset_code` not provided!");
    }

    if (!this.info || !this.info[this.operation]) {
      throw new Error(
        `Run fetchSupportedAssets before running ${functionName}!`,
      );
    }

    const assetInfo = this.info[this.operation][asset_code];

    if (!assetInfo) {
      throw new Error(
        `Asset ${asset_code} is not supported by ${this.transferServer}`,
      );
    }

    const isAuthRequired = !!assetInfo.authentication_required;

    // if the asset requires authentication, require an auth_token
    if (isAuthRequired && !this.authToken) {
      throw new Error(
        `
        Asset ${asset_code} requires authentication. Run KeyManager's 
        fetchAuthToken function, then run setAuthToken to set it.
        `,
      );
    }

    return isAuthRequired;
  }
}
