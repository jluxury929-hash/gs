// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ LOW GAS UNIFIED BACKEND - 0.005 ETH minimum (saves ~$17 vs standard)
// Deploy to Railway with TREASURY_PRIVATE_KEY env var
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

// ⚡ LOW GAS CONFIGURATION
const COINBASE_WALLET = '0x4024Fd78E2AD5532FBF3ec2B3eC83870FAe45fC7';
const TREASURY_WALLET = '0x0fF31D4cdCE8B3f7929c04EbD4cd852608DC09f4';
const ETH_PRICE = 3450;
const MIN_GAS_ETH = 0.005; // ⚡ LOW GAS: 0.005 instead of 0.01
const GAS_LIMIT = 21000; // Minimum for simple ETH transfer
const MAX_PRIORITY_FEE = 1000000000n; // 1 gwei - minimum priority

const RPC_URLS = [
  'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq',
  'https://mainnet.infura.io/v3/da4d2c950f0c42f3a69e344fb954a84f',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com'
];

let provider = null;
let signer = null;
let totalEarnings = 0;

async function initProvider() {
  for (const rpc of RPC_URLS) {
    try {
      const testProvider = new ethers.JsonRpcProvider(rpc);
      await testProvider.getBlockNumber();
      provider = testProvider;
      if (PRIVATE_KEY) {
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log('[OK] Treasury:', signer.address);
      }
      console.log('[OK] RPC:', rpc.split('/')[2]);
      return true;
    } catch (e) { continue; }
  }
  return false;
}

async function getTreasuryBalance() {
  try {
    if (!provider || !signer) await initProvider();
    const bal = await provider.getBalance(signer.address);
    return parseFloat(ethers.formatEther(bal));
  } catch (e) { return 0; }
}

// ⚡ LOW GAS SEND - Uses minimum gas settings
async function sendETHLowGas(to, amountETH) {
  if (!provider || !signer) await initProvider();
  
  const balance = await provider.getBalance(signer.address);
  const balanceETH = parseFloat(ethers.formatEther(balance));
  
  // Reserve only 0.002 ETH for gas (vs 0.003 standard)
  const maxSend = balanceETH - 0.002;
  if (amountETH > maxSend) {
    throw new Error(`Insufficient: have ${balanceETH.toFixed(6)}, max send ${maxSend.toFixed(6)}`);
  }
  
  const feeData = await provider.getFeeData();
  
  // ⚡ LOW GAS: Use minimum priority fee
  const tx = await signer.sendTransaction({
    to: to,
    value: ethers.parseEther(amountETH.toFixed(18)),
    gasLimit: GAS_LIMIT,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE // 1 gwei minimum
  });
  
  const receipt = await tx.wait();
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

// STATUS
app.get('/', (req, res) => {
  res.json({
    name: '⚡ Low Gas Unified Backend',
    minGas: MIN_GAS_ETH + ' ETH',
    status: 'online',
    coinbase: COINBASE_WALLET,
    treasury: TREASURY_WALLET
  });
});

app.get('/status', async (req, res) => {
  const balance = await getTreasuryBalance();
  res.json({
    status: 'online',
    lowGasMode: true,
    minGasRequired: MIN_GAS_ETH,
    treasuryBalance: balance.toFixed(6),
    canWithdraw: balance >= MIN_GAS_ETH,
    totalEarnings: totalEarnings.toFixed(2),
    coinbase: COINBASE_WALLET,
    treasury: signer ? signer.address : TREASURY_WALLET
  });
});

app.get('/health', async (req, res) => {
  const balance = await getTreasuryBalance();
  res.json({ status: 'healthy', balance: balance.toFixed(6), canWithdraw: balance >= MIN_GAS_ETH });
});

app.get('/balance', async (req, res) => {
  const balance = await getTreasuryBalance();
  res.json({ balance: balance.toFixed(6), canWithdraw: balance >= MIN_GAS_ETH });
});

app.get('/earnings', (req, res) => {
  res.json({ totalEarnings: totalEarnings.toFixed(2), availableETH: (totalEarnings / ETH_PRICE).toFixed(6) });
});

app.get('/api/apex/strategies/live', async (req, res) => {
  const balance = await getTreasuryBalance();
  res.json({
    totalPnL: totalEarnings,
    projectedHourly: totalEarnings > 0 ? totalEarnings / 24 : 15000,
    treasuryBalance: balance.toFixed(6),
    lowGasMode: true,
    canTrade: balance >= MIN_GAS_ETH
  });
});

// CREDIT EARNINGS
app.post('/credit-earnings', (req, res) => {
  const amount = parseFloat(req.body.amountUSD || req.body.amount) || 0;
  if (amount > 0) totalEarnings += amount;
  res.json({ success: true, totalEarnings: totalEarnings.toFixed(2) });
});

// ⚡ LOW GAS WITHDRAWAL ENDPOINTS
app.post('/send-to-coinbase', async (req, res) => {
  try {
    const { amountETH, amount, to } = req.body;
    const destination = to || COINBASE_WALLET;
    const ethAmount = parseFloat(amountETH) || parseFloat(amount) || 0;
    
    if (ethAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    
    const result = await sendETHLowGas(destination, ethAmount);
    totalEarnings = Math.max(0, totalEarnings - (ethAmount * ETH_PRICE));
    
    console.log('[OK] Low gas send:', ethAmount, 'ETH to', destination);
    res.json({ success: true, ...result, amount: ethAmount, to: destination });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/coinbase-withdraw', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });
app.post('/withdraw', (req, res) => { if (!req.body.to) req.body.to = COINBASE_WALLET; req.url = '/send-to-coinbase'; app._router.handle(req, res); });
app.post('/send-eth', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });
app.post('/transfer', (req, res) => { req.url = '/send-to-coinbase'; app._router.handle(req, res); });

app.post('/backend-to-coinbase', async (req, res) => {
  try {
    const { amountETH, amount } = req.body;
    let ethAmount = parseFloat(amountETH) || parseFloat(amount) || 0;
    
    const balance = await getTreasuryBalance();
    const maxSend = balance - 0.002;
    
    if (ethAmount <= 0) ethAmount = maxSend;
    if (ethAmount <= 0 || ethAmount > maxSend) {
      return res.status(400).json({ error: 'Insufficient', max: maxSend.toFixed(6) });
    }
    
    const result = await sendETHLowGas(COINBASE_WALLET, ethAmount);
    console.log('[OK] Backend->Coinbase:', ethAmount, 'ETH');
    res.json({ success: true, ...result, amount: ethAmount, to: COINBASE_WALLET });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/transfer-to-coinbase', (req, res) => { req.url = '/backend-to-coinbase'; app._router.handle(req, res); });
app.post('/treasury-to-coinbase', (req, res) => { req.url = '/backend-to-coinbase'; app._router.handle(req, res); });

app.post('/fund-backend', (req, res) => {
  const amount = parseFloat(req.body.amountETH) || 0;
  totalEarnings = Math.max(0, totalEarnings - (amount * ETH_PRICE));
  res.json({ success: true, message: 'Allocated to gas' });
});
app.post('/fund-from-earnings', (req, res) => { req.url = '/fund-backend'; app._router.handle(req, res); });
app.post('/send-to-backend', (req, res) => { req.url = '/fund-backend'; app._router.handle(req, res); });

// START
app.listen(PORT, '0.0.0.0', function() {
  console.log('[OK] ⚡ Low Gas Server on port', PORT);
  initProvider().then(async () => {
    const balance = await getTreasuryBalance();
    console.log('═══════════════════════════════════════');
    console.log('⚡ LOW GAS BACKEND - Min:', MIN_GAS_ETH, 'ETH');
    console.log('Treasury:', signer ? signer.address : TREASURY_WALLET);
    console.log('Balance:', balance.toFixed(6), 'ETH');
    console.log('═══════════════════════════════════════');
  });
});
