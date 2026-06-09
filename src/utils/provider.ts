/**
 * Polygon RPC Provider Factory
 *
 * Centralizes creation of the Polygon JSON-RPC provider used across the bot.
 *
 * Why StaticJsonRpcProvider:
 * A plain `ethers.providers.JsonRpcProvider` performs an `eth_chainId` probe on
 * first use to "detect" the network. When the RPC endpoint rate-limits or
 * momentarily drops that probe, ethers throws/logs:
 *
 *   could not detect network (event="noNetwork", code=NETWORK_ERROR)
 *
 * `StaticJsonRpcProvider` SKIPS that probe entirely: it trusts the network
 * passed to the constructor and never re-detects it. By hard-pinning the
 * Polygon network ({ chainId: 137, name: 'matic' }) we kill the NETWORK_ERROR
 * spam at the root instead of papering over it downstream.
 *
 * This is ethers v5 (see `import { ethers } from 'ethers'` + `ethers.providers.*`
 * usage in src/services/onchain-service.ts and src/clients/ctf-client.ts).
 */

import { ethers } from 'ethers';

/**
 * The Polygon RPC URL the provider connects to.
 *
 * Prefers `process.env.POLYGON_RPC_URL` when set, otherwise falls back to the
 * public Polygon endpoint already used elsewhere in the codebase.
 */
export const POLYGON_RPC_URL: string =
  process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

/**
 * The Polygon mainnet network, pinned so the provider never runs eth_chainId
 * network detection.
 */
const POLYGON_NETWORK: ethers.providers.Network = {
  chainId: 137,
  name: 'matic',
};

/**
 * Build a Polygon `StaticJsonRpcProvider`.
 *
 * The network is hard-pinned to Polygon mainnet (chainId 137 / 'matic'), so the
 * provider skips the `eth_chainId` detection probe that produces the
 * "could not detect network (NETWORK_ERROR)" noise.
 *
 * @returns A configured ethers v5 StaticJsonRpcProvider for Polygon.
 */
export function getPolygonProvider(
  url: string = POLYGON_RPC_URL
): ethers.providers.StaticJsonRpcProvider {
  return new ethers.providers.StaticJsonRpcProvider(
    url || POLYGON_RPC_URL,
    POLYGON_NETWORK
  );
}
