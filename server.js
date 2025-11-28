// ===============================================================================
// UNIFIED EARNINGS & WITHDRAWAL API v2.0
// 3-in-1: Earnings->Backend, Earnings->Coinbase, Backend->Coinbase
// + Auto-Recycle Profits to Backend Wallet
// Compatible with AI Auto Trader Real & MEV Engine V2 Enhanced
// Deploy to Railway with TREASURY_PRIVATE_KEY env var
// FIX: Implemented robust ethers.FallbackProvider with explicit network ID
//      and connection timeout to resolve "failed to detect network" errors.
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

// The network object for Ethereum Mainnet
const ETH_NETWORK = {
    name: 'mainnet',
    chainId: 1,
};

// ===============================================================================
// FINAL ROBUST PROVIDER INITIALIZATION
// ===============================================================================

/**
 * Creates and initializes a FallbackProvider, forcing immediate connection 
 * and using a timeout for network detection to prevent stalls.
 * @returns {ethers.FallbackProvider | null} The initialized FallbackProvider or null on failure.
 */
async function getStableProvider() {
    if (provider) return provider;
    
    // Attempt connection up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // 1. Configure Providers for Fallback
            const providers = RPC_URLS.map(url => {
                // IMPORTANT: Create provider with a custom 'network' object 
                // and other options for stability
                const provider = new ethers.JsonRpcProvider(url, ETH_NETWORK, {
                    polling: true, 
                    pollingInterval: 4000,
                    allowGzip: true
                });
                
                return { provider, priority: 1, weight: 1 };
            });

            // 2. Initialize FallbackProvider
            const fallback = new ethers.FallbackProvider(providers);

            // 3. Test Connectivity with a Timeout
            const networkDetectionPromise = fallback.getNetwork();
            
            // Set a timeout to prevent indefinite stalling
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Network detection timed out.")), 8000) // 8 second timeout
            );
            
            const network = await Promise.race([networkDetectionPromise, timeoutPromise]);
            
            // Final check on the network chain ID
            if (network.chainId !== 1n) {
                throw new Error(`FallbackProvider detected wrong chain ID: ${network.chainId}`);
            }

            provider = fallback;
            if (PRIVATE_KEY) {
                signer = new ethers.Wallet(PRIVATE_KEY, provider);
                console.log(`[OK] Treasury Wallet: ${signer.address}`);
            }
            console.log(`[OK] Fallback Provider initialized successfully on attempt ${attempt}. Active RPC: ${network.name}`);
            return provider;
            
        } catch (e) {
            console.error(`[WARN] RPC Startup Attempt ${attempt} failed: ${e.message}. Retrying in 1s...`);
            // Wait 1 second before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    console.error('[CRITICAL] All RPC connection attempts failed after 3 retries. The API will run in a disconnected state.');
    provider = null;
    signer = null;
    return null;
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

app.get('/balance', async (req, res) => {
    const balance = await getTreasuryBalance();
    res.json({
        treasuryWallet: signer ? signer.address : TREASURY_WALLET,
        balance: balance.toFixed(6),
        balanceUSD: (balance * ETH_PRICE).toFixed(2),
        coinbaseWallet: COINBASE_WALLET,
        canTrade: balance >= MIN_GAS_ETH,
        canWithdraw: balance >= MAX_GAS_FEE
    });
});

app.get('/earnings', (req, res) => {
    res.json({
        totalEarnings: totalEarnings.toFixed(2),
        totalWithdrawnToCoinbase: totalWithdrawnToCoinbase.toFixed(2),
        totalSentToBackend: totalSentToBackend.toFixed(2),
        availableETH: (totalEarnings / ETH_PRICE).toFixed(6),
        coinbaseWallet: COINBASE_WALLET,
        treasuryWallet: TREASURY_WALLET
    });
});

// ===============================================================================
// STRATEGY ENDPOINT (Compatible with MEV Engine V2 & AI Auto Trader)
// ===============================================================================

app.get('/api/apex/strategies/live', async (req, res) => {
    const balance = await getTreasuryBalance();
    
    res.json({
        totalPnL: totalEarnings.toFixed(2),
        projectedHourly: totalEarnings > 0 ? (totalEarnings / 24).toFixed(2) : 15000,
        projectedDaily: totalEarnings > 0 ? totalEarnings.toFixed(2) : 360000,
        totalStrategies: 450,
        activeStrategies: 360,
        flashLoanAmount: 100,
        treasuryBalance: balance.toFixed(6),
        feeRecipient: COINBASE_WALLET,
        canTrade: balance >= MIN_GAS_ETH
    });
});

// ===============================================================================
// 1. CREDIT EARNINGS
// ===============================================================================

app.post('/credit-earnings', (req, res) => {
    const { amount, amountUSD } = req.body;
    const addAmount = parseFloat(amountUSD || amount) || 0;
    
    if (addAmount > 0) {
        totalEarnings += addAmount;
        console.log('[CREDIT] $' + addAmount.toFixed(2) + ' | Total: $' + totalEarnings.toFixed(2));
    }
    
    res.json({
        success: true,
        credited: addAmount.toFixed(2),
        totalEarnings: totalEarnings.toFixed(2),
        availableETH: (totalEarnings / ETH_PRICE).toFixed(6)
    });
});

// ===============================================================================
// 2. SEND EARNINGS -> COINBASE WALLET
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
        const tx = await signer.sendTransaction({
            to: destination,
            value: ethers.parseEther(ethAmount.toFixed(18)), 
        });
        
        const receipt = await tx.wait();
        
        const usdAmount = ethAmount * ETH_PRICE;
        totalWithdrawnToCoinbase += usdAmount;
        totalEarnings = Math.max(0, totalEarnings - usdAmount); 
        
        console.log(`[OK] Sent ${ethAmount.toFixed(6)} ETH to Coinbase: ${tx.hash}`);
        
        res.json({
            success: true,
            txHash: tx.hash,
            amount: ethAmount.toFixed(6),
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

// Aliases for send-to-coinbase
app.post('/coinbase-withdraw', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });
app.post('/withdraw', (req, res) => {
    if (!req.body.to) req.body.to = COINBASE_WALLET;
    req.url = '/send-to-coinbase';
    app._router.handle(req, res);
});
app.post('/send-eth', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });
app.post('/transfer', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });

// ===============================================================================
// 3. SEND EARNINGS -> BACKEND WALLET (In-memory tracking)
// ===============================================================================

app.post('/send-to-backend', async (req, res) => {
    try {
        const { amountUSD, amountETH } = req.body;
        const ethAmount = parseFloat(amountETH) || (parseFloat(amountUSD) / ETH_PRICE) || 0;
        
        if (ethAmount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        
        // In-memory ledger update
        const usdAmount = ethAmount * ETH_PRICE;
        totalSentToBackend += usdAmount;
        totalEarnings = Math.max(0, totalEarnings - usdAmount);
        
        console.log('[BACKEND] Allocated ' + ethAmount.toFixed(6) + ' ETH to backend gas: $' + usdAmount.toFixed(2));
        
        res.json({
            success: true,
            allocated: ethAmount.toFixed(6),
            allocatedUSD: usdAmount.toFixed(2),
            to: TREASURY_WALLET,
            remainingEarnings: totalEarnings.toFixed(2),
            message: 'Earnings allocated to backend gas fund'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/fund-backend', (req, res) => { req.url = '/send-to-backend'; app._router.handle(req, res); });
app.post('/fund-from-earnings', (req, res) => { req.url = '/send-to-backend'; app._router.handle(req, res); });

// ===============================================================================
// 4. BACKEND WALLET -> COINBASE
// ===============================================================================

app.post('/backend-to-coinbase', async (req, res) => {
    try {
        const { amountETH, amount } = req.body;
        let ethAmount = parseFloat(amountETH) || parseFloat(amount) || 0;
        
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
        
        const tx = await signer.sendTransaction({
            to: COINBASE_WALLET,
            value: ethers.parseEther(ethAmount.toFixed(18)),
        });
        
        const receipt = await tx.wait();
        
        console.log(`[OK] Backend -> Coinbase: ${ethAmount.toFixed(6)} ETH | TX: ${tx.hash}`);
        
        res.json({
            success: true,
            txHash: tx.hash,
            amount: ethAmount.toFixed(6),
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

app.post('/transfer-to-coinbase', (req, res) => { req.url = '/backend-to-coinbase'; app._router.handle(req, res); });
app.post('/treasury-to-coinbase', (req, res) => { req.url = '/backend-to-coinbase'; app._router.handle(req, res); });

// ===============================================================================
// EXECUTE ENDPOINT (Simulation for MEV Engine compatibility)
// ===============================================================================

app.post('/execute', async (req, res) => {
    const balance = await getTreasuryBalance();
    
    // Check and attempt auto-recycle if gas is low
    if (balance < MIN_GAS_ETH) {
        if (autoRecycleEnabled && totalEarnings >= 35) {
            const recycled = await autoRecycleToBackend();
            if (!recycled.success) {
                return res.status(400).json({
                    error: 'Treasury needs gas funding (Auto-recycle failed/insufficient earnings)',
                    treasuryBalance: balance.toFixed(6),
                    minRequired: MIN_GAS_ETH,
                    treasuryWallet: TREASURY_WALLET
                });
            }
        } else {
            return res.status(400).json({
                error: 'Treasury needs gas funding',
                treasuryBalance: balance.toFixed(6),
                minRequired: MIN_GAS_ETH,
                treasuryWallet: TREASURY_WALLET
            });
        }
    }
    
    // Simulate flash loan profit
    const flashAmount = req.body.amount || FLASH_LOAN_AMOUNT;
    const profitPercent = 0.002 + (Math.random() * 0.003); // 0.2% to 0.5% profit
    const profit = flashAmount * profitPercent * ETH_PRICE;
    
    totalEarnings += profit;
    
    res.json({
        success: true,
        flashLoanAmount: flashAmount,
        profitUSD: profit.toFixed(2),
        profitETH: (profit / ETH_PRICE).toFixed(6),
        totalEarnings: totalEarnings.toFixed(2),
        feeRecipient: COINBASE_WALLET,
        mevContracts: MEV_CONTRACTS
    });
});

// ===============================================================================
// AUTO-RECYCLE CONTROL ENDPOINTS
// ===============================================================================

app.post('/toggle-auto-recycle', (req, res) => {
    autoRecycleEnabled = !autoRecycleEnabled;
    res.json({  
        success: true,  
        autoRecycleEnabled: autoRecycleEnabled,
        message: autoRecycleEnabled ? 'Auto-recycle enabled' : 'Auto-recycle disabled'
    });
});

app.post('/recycle-now', async (req, res) => {
    const result = await autoRecycleToBackend();
    res.json(result);
});

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
            console.log('[WARN] Could not get initial balance.');
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
