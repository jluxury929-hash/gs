// ===============================================================================
// UNIFIED EARNINGS & WITHDRAWAL API v2.0
// 3-in-1: Earnings->Backend, Earnings->Coinbase, Backend->Coinbase
// + Auto-Recycle Profits to Backend Wallet
// Compatible with AI Auto Trader Real & MEV Engine V2 Enhanced
// Deploy to Railway with TREASURY_PRIVATE_KEY env var
// FIX: Implemented ethers.FallbackProvider for robust RPC connection.
// ===============================================================================

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers'); // Using ethers v6

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// ===============================================================================
// WALLET CONFIGURATION
// ===============================================================================

// YOUR Coinbase wallet - ALL profits go here
const COINBASE_WALLET = '0x4024Fd78E2AD5532FBF3ec2B3eC83870FAe45fC7';

// Backend/Treasury wallet - holds ETH for gas
const TREASURY_WALLET = '0x0fF31D4cdCE8B3f7929c04EbD4cd852608DC09f4';

// Flash Loan API (Simulated)
const FLASH_API = 'https://theflash-production.up.railway.app';

// Your deployed MEV contracts (Simulated)
const MEV_CONTRACTS = [
    '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0',
    '0x29983BE497D4c1D39Aa80D20Cf74173ae81D2af5',
    '0x0b8Add0d32eFaF79E6DB4C58CcA61D6eFBCcAa3D',
    '0xf97A395850304b8ec9B8f9c80A17674886612065',
];

const ETH_PRICE = 3450;
const MIN_GAS_ETH = 0.01;
const MAX_GAS_FEE = 0.003; // Max gas fee buffer to keep when withdrawing
const FLASH_LOAN_AMOUNT = 100; // 100 ETH flash loan

// ===============================================================================
// ALL RPC ENDPOINTS (Configured for FallbackProvider)
// ===============================================================================
const RPC_URLS = [
    'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq',
    'https://mainnet.infura.io/v3/da4d2c950f0c42f3a69e344fb954a84f',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
    'https://1rpc.io/eth',
    'https://eth-mainnet.public.blastapi.io',
    'https://eth.drpc.org'
];

// FallbackProvider automatically switches to a working RPC if one fails, fixing stability issues.
let provider = null;
let signer = null;

// In-memory state
let totalEarnings = 0;
let totalWithdrawnToCoinbase = 0;
let totalSentToBackend = 0;
let totalRecycled = 0;
let autoRecycleEnabled = true;

/**
 * Creates and initializes a FallbackProvider for robust RPC connections.
 * @returns {ethers.FallbackProvider} The initialized FallbackProvider.
 */
async function getStableProvider() {
    if (provider) return provider;
    
    // Convert RPC URLs to Provider objects for the FallbackProvider
    const providers = RPC_URLS.map(url => new ethers.JsonRpcProvider(url));

    // Create a FallbackProvider that cycles through all providers
    const fallback = new ethers.FallbackProvider(providers);
    
    try {
        // Test connectivity once
        await fallback.getBlockNumber();
        provider = fallback;
        if (PRIVATE_KEY) {
            signer = new ethers.Wallet(PRIVATE_KEY, provider);
            console.log('[OK] Treasury Wallet:', signer.address);
        }
        console.log(`[OK] Fallback Provider initialized with ${RPC_URLS.length} endpoints.`);
        return provider;
    } catch (e) {
        console.error('[CRITICAL] All RPC endpoints failed to connect:', e.message);
        provider = null;
        signer = null;
        return null;
    }
}

async function getTreasuryBalance() {
    try {
        if (!provider) await getStableProvider();
        if (!provider || !signer) return 0; // Cannot proceed without a provider/signer
        
        const bal = await provider.getBalance(signer.address);
        return parseFloat(ethers.formatEther(bal)); // Use formatEther for v6
    } catch (e) {
        console.error('[ERROR] Failed to get treasury balance:', e.message);
        return 0;
    }
}

// ===============================================================================
// AUTO-RECYCLE
// ===============================================================================
async function autoRecycleToBackend() {
    if (!autoRecycleEnabled) return { success: false, reason: 'Auto-recycle disabled' };
    
    const balance = await getTreasuryBalance();
    if (balance >= MIN_GAS_ETH) {
        return { success: false, reason: 'Treasury has sufficient gas' };
    }
    
    // Check if earnings are sufficient to fund MIN_GAS_ETH
    const neededUSD = (MIN_GAS_ETH - balance) * ETH_PRICE;
    
    if (totalEarnings < neededUSD) {
        return { success: false, reason: `Insufficient earnings to recycle (need $${neededUSD.toFixed(2)}+)` };
    }
    
    // Recycle enough to meet MIN_GAS_ETH
    const recycleETH = MIN_GAS_ETH - balance;
    const recycleUSD = recycleETH * ETH_PRICE;
    
    // Since this is an *in-memory* earnings pool, we just update the ledger.
    // The actual transfer of funds would be an internal accounting step.
    totalEarnings -= recycleUSD;
    totalRecycled += recycleUSD;
    
    console.log(`[RECYCLE] Auto-recycled $${recycleUSD.toFixed(2)} -> ${recycleETH.toFixed(6)} ETH to backend`);
    
    return { 
        success: true, 
        recycledETH: recycleETH.toFixed(6),
        recycledUSD: recycleUSD.toFixed(2),
        remainingEarnings: totalEarnings.toFixed(2)
    };
}

// ===============================================================================
// STATUS & HEALTH ENDPOINTS
// ===============================================================================

app.get('/', (req, res) => {
    res.json({
        name: 'Unified Earnings & Withdrawal API',
        version: '2.0.0 (Fixed RPC)',
        status: 'online',
        coinbaseWallet: COINBASE_WALLET,
        treasuryWallet: TREASURY_WALLET,
        endpoints: {
            GET: ['/', '/status', '/health', '/balance', '/earnings', '/api/apex/strategies/live'],
            POST: [
                '/credit-earnings',
                '/send-to-coinbase', '/coinbase-withdraw', '/withdraw',
                '/send-to-backend', '/fund-backend',
                '/backend-to-coinbase', '/transfer-to-coinbase',
                '/execute', '/fund-from-earnings'
            ]
        }
    });
});

app.get('/status', async (req, res) => {
    // Ensure provider is initialized before auto-recycle check
    if (!provider) await getStableProvider(); 
    const balance = await getTreasuryBalance();
    
    // Auto-recycle check
    if (autoRecycleEnabled && balance < MIN_GAS_ETH && totalEarnings >= 35) {
        await autoRecycleToBackend();
    }
    
    // Re-fetch balance after potential recycle
    const finalBalance = await getTreasuryBalance(); 
    
    res.json({
        status: 'online',
        trading: true,
        blockchain: provider ? 'connected' : 'disconnected (RPC failure)',
        coinbaseWallet: COINBASE_WALLET,
        treasuryWallet: signer ? signer.address : TREASURY_WALLET,
        treasuryBalance: finalBalance.toFixed(6),
        treasuryBalanceUSD: (finalBalance * ETH_PRICE).toFixed(2),
        canTrade: finalBalance >= MIN_GAS_ETH,
        canWithdraw: finalBalance >= MAX_GAS_FEE,
        minGasRequired: MIN_GAS_ETH,
        totalEarnings: totalEarnings.toFixed(2),
        totalWithdrawnToCoinbase: totalWithdrawnToCoinbase.toFixed(2),
        totalSentToBackend: totalSentToBackend.toFixed(2),
        totalRecycled: totalRecycled.toFixed(2),
        autoRecycleEnabled: autoRecycleEnabled,
        availableETH: (totalEarnings / ETH_PRICE).toFixed(6),
        flashLoanAmount: FLASH_LOAN_AMOUNT,
        mevContracts: MEV_CONTRACTS,
        rpcEndpoints: RPC_URLS.length,
        timestamp: new Date().toISOString()
    });
});

app.get('/health', async (req, res) => {
    if (!provider) await getStableProvider();
    const balance = await getTreasuryBalance();
    res.json({ 
        status: 'healthy', 
        treasuryBalance: balance.toFixed(6),
        canWithdraw: balance >= MAX_GAS_FEE
    });
});

// ... (Other GET endpoints /balance, /earnings, /api/apex/strategies/live are OK)

// ===============================================================================
// 2. SEND EARNINGS -> COINBASE WALLET
// FIX: Using modern Ethers.js v6 transaction handling
// ===============================================================================

app.post('/send-to-coinbase', async (req, res) => {
    try {
        const { amountUSD, amountETH, amount, to } = req.body;
        const destination = to || COINBASE_WALLET;
        let ethAmount = parseFloat(amountETH) || parseFloat(amount) || 0;
        
        if (!ethAmount && amountUSD) {
            ethAmount = parseFloat(amountUSD) / ETH_PRICE;
        }
        
        if (ethAmount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        
        // Ensure provider and signer are ready
        if (!provider || !signer) {
            await getStableProvider();
            if (!provider || !signer) {
                return res.status(503).json({ error: 'RPC or Wallet Not Initialized' });
            }
        }
        
        const balanceETH = await getTreasuryBalance();
        // Reserve MAX_GAS_FEE (0.003 ETH) for future gas
        const maxSend = balanceETH - MAX_GAS_FEE; 
        
        if (ethAmount > maxSend) {
            return res.status(400).json({ 
                error: 'Insufficient treasury balance (reserving gas fee)',
                treasuryBalance: balanceETH.toFixed(6),
                maxWithdrawable: Math.max(0, maxSend).toFixed(6),
                requested: ethAmount.toFixed(6)
            });
        }
        
        // Use signer's built-in transaction methods for EIP-1559 compatibility
        // The signer handles fee estimation automatically.
        const tx = await signer.sendTransaction({
            to: destination,
            // Use ethers.parseEther for v6
            value: ethers.parseEther(ethAmount.toFixed(18)), 
        });
        
        const receipt = await tx.wait();
        
        const usdAmount = ethAmount * ETH_PRICE;
        totalWithdrawnToCoinbase += usdAmount;
        totalEarnings = Math.max(0, totalEarnings - usdAmount); // Assuming a successful on-chain withdrawal reduces earnings
        
        console.log(`[OK] Sent ${ethAmount} ETH to Coinbase: ${tx.hash}`);
        
        res.json({
            success: true,
            txHash: tx.hash,
            amount: ethAmount,
            amountUSD: usdAmount.toFixed(2),
            to: destination,
            from: signer.address,
            blockNumber: receipt.blockNumber,
            etherscanUrl: 'https://etherscan.io/tx/' + tx.hash
        });
        
    } catch (error) {
        console.error('Send to Coinbase error:', error);
        res.status(500).json({ error: `Transaction failed: ${error.message}` });
    }
});

// Aliases remain the same

// ===============================================================================
// 3. SEND EARNINGS -> BACKEND WALLET (In-memory tracking remains the same)
// ===============================================================================
// ... (The /send-to-backend logic is for in-memory tracking only, no change needed)

// ===============================================================================
// 4. BACKEND WALLET -> COINBASE (Direct treasury to your wallet)
// FIX: Using modern Ethers.js v6 transaction handling
// ===============================================================================

app.post('/backend-to-coinbase', async (req, res) => {
    try {
        const { amountETH, amount } = req.body;
        let ethAmount = parseFloat(amountETH) || parseFloat(amount) || 0;
        
        // Ensure provider and signer are ready
        if (!provider || !signer) {
            await getStableProvider();
            if (!provider || !signer) {
                return res.status(503).json({ error: 'RPC or Wallet Not Initialized' });
            }
        }
        
        const balanceETH = await getTreasuryBalance();
        const maxSend = balanceETH - MAX_GAS_FEE;
        
        // If no amount specified, send max
        if (ethAmount <= 0) {
            ethAmount = maxSend;
        }
        
        if (ethAmount <= 0 || ethAmount > maxSend) {
            return res.status(400).json({ 
                error: 'Insufficient treasury balance (reserving gas fee)',
                treasuryBalance: balanceETH.toFixed(6),
                maxWithdrawable: Math.max(0, maxSend).toFixed(6)
            });
        }
        
        // Use signer's built-in transaction methods for EIP-1559 compatibility
        const tx = await signer.sendTransaction({
            to: COINBASE_WALLET,
            value: ethers.parseEther(ethAmount.toFixed(18)),
        });
        
        const receipt = await tx.wait();
        
        console.log(`[OK] Backend -> Coinbase: ${ethAmount} ETH | TX: ${tx.hash}`);
        
        res.json({
            success: true,
            txHash: tx.hash,
            amount: ethAmount,
            amountUSD: (ethAmount * ETH_PRICE).toFixed(2),
            from: signer.address,
            to: COINBASE_WALLET,
            blockNumber: receipt.blockNumber,
            etherscanUrl: 'https://etherscan.io/tx/' + tx.hash
        });
        
    } catch (error) {
        console.error('Backend to Coinbase error:', error);
        res.status(500).json({ error: `Transaction failed: ${error.message}` });
    }
});

// Aliases remain the same
// ... (Execute endpoint logic is for simulation and remains the same)
// ... (Auto-Recycle Control Endpoints logic remains the same)

// ===============================================================================
// STARTUP - Uses the new getStableProvider
// ===============================================================================

app.listen(PORT, '0.0.0.0', async function() {
    console.log('[OK] Server listening on port ' + PORT);
    
    // Connect to RPC using the new stable provider
    const stableProvider = await getStableProvider();

    let balance = 0;
    let rpcStatus = 'FAILED';

    if (stableProvider) {
        rpcStatus = 'CONNECTED (Fallback Provider)';
        try {
            balance = await getTreasuryBalance();
        } catch (e) {
            console.log('[WARN] Could not get initial balance:', e.message);
        }
    }
    
    console.log('');
    console.log('===============================================================================');
    console.log('UNIFIED EARNINGS & WITHDRAWAL API v2.0');
    console.log('===============================================================================');
    console.log('Port: ' + PORT);
    console.log('Coinbase: ' + COINBASE_WALLET);
    console.log('Treasury: ' + (signer ? signer.address : TREASURY_WALLET));
    console.log('Balance: ' + balance.toFixed(6) + ' ETH');
    console.log('RPC: ' + rpcStatus);
    console.log('===============================================================================');
});
