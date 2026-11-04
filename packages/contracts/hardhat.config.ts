import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-toolbox"

// Keys come from the environment only. Never commit them.
const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : []

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" }
    },
    networks: {
        monadTestnet: { url: process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz", chainId: 10143, accounts },
        monad: { url: process.env.MONAD_RPC ?? "https://rpc.monad.xyz", chainId: 143, accounts }
    },
    // Source verification on the Monad explorers (testnet.monadexplorer.com) through Sourcify:
    //   npx hardhat verify --network monadTestnet <address> <constructor args...>
    sourcify: {
        enabled: true,
        apiUrl: "https://sourcify-api-monad.blockvision.org",
        browserUrl: "https://testnet.monadexplorer.com"
    },
    etherscan: { enabled: false },
    mocha: { timeout: 300_000 }
}

export default config
