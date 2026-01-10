require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const qs = require('querystring');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const ATLANTIC_BASE_URL = 'https://atlantich2h.com';
const API_KEY = process.env.ATLANTIC_API_KEY;

const config = {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Atlantic-Vercel/2.0' }
};

// 1. Ambil Data
app.get('/api/services', async (req, res) => {
    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/layanan/price_list`, 
            qs.stringify({ api_key: API_KEY, type: 'prabayar' }), config);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: false });
    }
});

// 2. Create Payment (Matematika Profit Bersih 500)
app.post('/api/create-payment', async (req, res) => {
    const { service_code, target, price_original } = req.body;
    
    // RUMUS:
    // Biaya Layanan QRIS Instant Atlantic = 1.4% + Rp 200
    // Target Profit Bersih = Rp 500
    // Rumus Harga Jual = (Modal + 500 + 200) / (1 - 0.014)
    
    const modal = parseInt(price_original);
    const profitBersih = 500;
    const feeFix = 200; // Biaya fix QRIS
    const feePersen = 0.014; // 1.4%

    // Pembulatan ke atas biar aman
    const nominalBayar = Math.ceil((modal + profitBersih + feeFix) / (1 - feePersen));
    
    const reff_id = `PAY-${Date.now()}`;

    try {
        const depoRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/create`, 
            qs.stringify({
                api_key: API_KEY, reff_id: reff_id, nominal: nominalBayar,
                type: 'ewallet', metode: 'qris'
            }), config);

        if (depoRes.data.status) {
            res.json({
                status: true,
                data: {
                    deposit_id: depoRes.data.data.id,
                    qr_image: depoRes.data.data.qr_image,
                    amount: nominalBayar,
                    // Kirim balik data target & code ke frontend (Stateless)
                    meta: { code: service_code, target: target }
                }
            });
        } else {
            res.json({ status: false, message: depoRes.data.message });
        }
    } catch (error) {
        res.status(500).json({ status: false, message: "Server Error" });
    }
});

// 3. Cek Status & Eksekusi
app.post('/api/check-status', async (req, res) => {
    const { deposit_id, meta } = req.body;

    try {
        // Cek Deposit
        const statusRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/status`,
            qs.stringify({ api_key: API_KEY, id: deposit_id }), config);
        
        let status = statusRes.data.data.status; // pending, processing, success

        // Auto Instant Claim
        if (status === 'processing') {
            try {
                const instant = await axios.post(`${ATLANTIC_BASE_URL}/deposit/instant`,
                    qs.stringify({ api_key: API_KEY, id: deposit_id, action: 'true' }), config);
                if(instant.data.status) status = 'success';
            } catch (e) {}
        }

        // Jika Sukses -> Beli Produk
        if (status === 'success') {
            const trxReff = `TRX-${deposit_id}`; // Reff ID unik per deposit
            const buyRes = await axios.post(`${ATLANTIC_BASE_URL}/transaksi/create`,
                qs.stringify({
                    api_key: API_KEY, code: meta.code, target: meta.target, reff_id: trxReff
                }), config);

            if (buyRes.data.status) {
                res.json({ status: true, state: 'success', sn: buyRes.data.data.sn });
            } else {
                // Handle duplicate entry (artinya sudah sukses sebelumnya)
                if(buyRes.data.message.includes('uplicate') || buyRes.data.message.includes('sudah ada')) {
                    res.json({ status: true, state: 'success', sn: 'Lihat Riwayat' });
                } else {
                    res.json({ status: true, state: 'failed', message: buyRes.data.message });
                }
            }
        } else if (status === 'cancel') {
            res.json({ status: true, state: 'expired' });
        } else {
            res.json({ status: true, state: 'pending' });
        }
    } catch (error) {
        res.status(500).json({ status: false });
    }
});

module.exports = app;
