"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { AccountProfile } from "./account-client";

type AccountContextValue = {
  account: AccountProfile;
  refreshAccount: () => Promise<void>;
  logout: () => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({
  account,
  refreshAccount,
  logout,
  children,
}: AccountContextValue & { children: ReactNode }) {
  return (
    <AccountContext.Provider value={{ account, refreshAccount, logout }}>
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext);
  if (!context) {
    throw new Error("useAccount must be used within AccountProvider");
  }
  return context;
}
