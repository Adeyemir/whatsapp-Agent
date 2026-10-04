import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import axios from "axios";
import { tool } from "ai";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const CIRCLE_CLI = fileURLToPath(new URL("../../../node_modules/.bin/circle", import.meta.url));
const ASSETS_URL = "https://api.xstocks.fi/api/v2/public/assets";
const SYMBOL = /^[A-Z0-9.]{1,12}x$/;
const USDC_AMOUNT = /^(?:[1-9]\d{0,5}|0)(?:\.\d{1,6})?$/;

type Deployment = { network: string; address: string };
type Asset = {
  name: string;
  symbol: string;
  isTradingHalted: boolean;
  deployments: Deployment[];
};

/** Check an official xStock and request a read-only Circle swap quote. */
export const inspectXStockBuy = tool({
  description:
    "Check whether a proposed USDC purchase of an xStock has an Arbitrum swap route. Reads the official xStocks asset registry and asks Circle CLI for a quote. This tool NEVER buys, transfers, bridges, or pays for anything.",
  inputSchema: z.object({
    symbol: z.string().describe("Underlying ticker or xStock symbol, such as NVDA or NVDAx"),
    usdcAmount: z.string().describe("USDC amount to quote, such as 1 or 1.5"),
  }),
  execute: async ({ symbol, usdcAmount }) => {
    const normalized = `${symbol.trim().replace(/x$/i, "").toUpperCase()}x`;
    if (!SYMBOL.test(normalized)) return { error: "Invalid xStock symbol." };
    if (!USDC_AMOUNT.test(usdcAmount) || Number(usdcAmount) < 1) {
      return { error: "Enter at least 1 USDC, with no more than six decimal places." };
    }

    let asset: Asset;
    try {
      const response = await axios.get<Asset>(`${ASSETS_URL}/${encodeURIComponent(normalized)}`, {
        timeout: 10_000,
      });
      asset = response.data;
    } catch (error) {
      return { error: `Could not fetch ${normalized} from the official xStocks API: ${(error as Error).message}` };
    }
    const deployment = asset.deployments?.find((item) => item.network === "Arbitrum");
    if (!deployment || !/^0x[a-fA-F0-9]{40}$/.test(deployment.address)) {
      return { error: `${normalized} has no verified Arbitrum deployment in the xStocks registry.` };
    }

    try {
      const { stdout } = await execFileAsync(
        CIRCLE_CLI,
        ["wallet", "swap", "USDC", usdcAmount, deployment.address, "--chain", "ARB", "--quote", "--output", "json"],
        { timeout: 30_000, maxBuffer: 256_000, env: { ...process.env, FORCE_COLOR: "0" } },
      );
      return {
        symbol: asset.symbol,
        name: asset.name,
        chain: "ARB",
        tokenAddress: deployment.address,
        amountUsdc: usdcAmount,
        issuerTradingHalted: asset.isTradingHalted,
        circleQuote: JSON.parse(stdout),
        note: "Read-only quote. A quote is not a purchase and may expire or change before execution.",
      };
    } catch (error) {
      const e = error as Error & { stderr?: string };
      return {
        symbol: asset.symbol,
        name: asset.name,
        chain: "ARB",
        tokenAddress: deployment.address,
        amountUsdc: usdcAmount,
        issuerTradingHalted: asset.isTradingHalted,
        quoteUnavailable: (e.stderr || e.message).trim().slice(0, 500),
        note: "No purchase was made. The Circle CLI must be current and logged in before it can quote this route.",
      };
    }
  },
});
