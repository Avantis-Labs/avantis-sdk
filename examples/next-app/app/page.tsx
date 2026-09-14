"use client";

/**
 * Minimal end-to-end trading panel — the canonical template to copy:
 * connect wallet -> enable one-click trading -> approve USDC -> live price
 * -> open/close positions with lifecycle toasts.
 */

import {
  positionCollateral,
  positionLeverage,
  positionOpenPrice,
  positionSide,
} from "veranta-sdk";
import {
  useAllowance,
  useApproveUsdc,
  useMarketClose,
  useMarketOpen,
  usePositions,
  usePrice,
  useSessionKey,
  useUsdcBalance,
} from "veranta-sdk/react";
import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

const PAIR = "ETH/USD";

const card: React.CSSProperties = {
  background: "#141922",
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
};
const button: React.CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: 0,
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
};
const input: React.CSSProperties = {
  background: "#0b0e14",
  color: "#e6e6e6",
  border: "1px solid #2a3242",
  borderRadius: 8,
  padding: 8,
  width: 90,
  marginRight: 8,
};

export default function Page() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const session = useSessionKey();
  const price = usePrice(PAIR);
  const balance = useUsdcBalance();
  const allowance = useAllowance();
  const positions = usePositions();

  const approve = useApproveUsdc();
  const [collateral, setCollateral] = useState(100);
  const [leverage, setLeverage] = useState(10);
  const [log, setLog] = useState<string[]>([]);
  const push = (line: string) => setLog((old) => [line, ...old].slice(0, 8));

  const open = useMarketOpen({
    onEvent: (event) => push(`${event.type}${event.data.code ? ` [${event.data.code}]` : ""}`),
    onSuccess: (receipt) => push(`filled: ${receipt.txHash?.slice(0, 18)}…`),
    onError: (error) => push(`error: ${error.message.slice(0, 80)}`),
  });
  const close = useMarketClose({
    onSuccess: () => push("closed"),
    onError: (error) => push(`error: ${error.message.slice(0, 80)}`),
  });

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 22 }}>Veranta SDK — trading panel</h1>

      <section style={card}>
        {isConnected ? (
          <>
            <span style={{ marginRight: 12 }}>
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </span>
            <button style={button} type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          connectors.map((connector) => (
            <button
              key={connector.uid}
              style={{ ...button, marginRight: 8 }}
              type="button"
              onClick={() => connect({ connector })}
            >
              Connect {connector.name}
            </button>
          ))
        )}
      </section>

      {isConnected && (
        <section style={card}>
          <b>One-click trading:</b> {session.status}
          {session.status !== "active" ? (
            <button
              style={{ ...button, marginLeft: 12 }}
              type="button"
              disabled={session.isEnabling}
              onClick={() => session.enable()}
            >
              {session.isEnabling ? "Enabling…" : "Enable (1 signature)"}
            </button>
          ) : (
            <button
              style={{ ...button, marginLeft: 12, background: "#7f1d1d" }}
              type="button"
              onClick={() => session.revoke()}
            >
              Revoke
            </button>
          )}
          {session.enableError && (
            <div style={{ color: "#f87171", marginTop: 8 }}>{session.enableError.message}</div>
          )}
        </section>
      )}

      <section style={card}>
        <div style={{ fontSize: 28, fontWeight: 600 }}>
          {PAIR}: {price ? `$${price.price.toLocaleString()}` : "…"}
        </div>
        <div style={{ opacity: 0.7 }}>
          balance: {balance.data?.toFixed(2) ?? "…"} USDC · allowance:{" "}
          {allowance.data?.allowanceUsdc ?? "…"}
          <button
            style={{ ...button, marginLeft: 12, padding: "4px 10px" }}
            type="button"
            disabled={approve.isPending}
            onClick={() => approve.mutate({})}
          >
            {approve.isPending ? "Approving…" : "Approve USDC"}
          </button>
        </div>
      </section>

      <section style={card}>
        <input
          style={input}
          type="number"
          value={collateral}
          onChange={(e) => setCollateral(Number(e.target.value))}
        />
        USDC ×
        <input
          style={{ ...input, marginLeft: 8 }}
          type="number"
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
        />
        <button
          style={{ ...button, background: "#15803d", marginRight: 8 }}
          type="button"
          disabled={open.isPending}
          onClick={() => open.mutate({ pair: PAIR, side: "long", collateral, leverage })}
        >
          Long
        </button>
        <button
          style={{ ...button, background: "#b91c1c" }}
          type="button"
          disabled={open.isPending}
          onClick={() => open.mutate({ pair: PAIR, side: "short", collateral, leverage })}
        >
          Short
        </button>
      </section>

      <section style={card}>
        <b>Positions</b>
        {(positions.data?.positions ?? []).map((position) => (
          <div
            key={`${position.pairIndex}-${position.index}`}
            style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}
          >
            <span>
              #{position.pairIndex}/{position.index} {positionSide(position)}{" "}
              {positionCollateral(position).toFixed(2)} USDC ×
              {positionLeverage(position).toFixed(1)} @ {positionOpenPrice(position).toFixed(2)}
            </span>
            <button
              style={{ ...button, padding: "4px 10px" }}
              type="button"
              disabled={close.isPending}
              onClick={() =>
                close.mutate({
                  pair: position.pairIndex,
                  tradeIndex: position.index,
                  collateralToClose: positionCollateral(position),
                })
              }
            >
              Close
            </button>
          </div>
        ))}
        {positions.data?.positions.length === 0 && (
          <div style={{ opacity: 0.6, marginTop: 8 }}>none</div>
        )}
      </section>

      <section style={card}>
        <b>Order journey</b>
        {log.map((line) => (
          <div key={line} style={{ opacity: 0.8, marginTop: 4 }}>
            {line}
          </div>
        ))}
      </section>
    </main>
  );
}
