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
    headers: { 
        'Content-Type': 'application/x-www-form-urlencoded', 
        'User-Agent': 'Atlantic-Vercel/5.0' 
    }
};

// 1. Ambil Data (Proxy ke Atlantic)
app.get('/api/services', async (req, res) => {
    try {
        // Request ke Atlantic
        const response = await axios.post(`${ATLANTIC_BASE_URL}/layanan/price_list`, 
            qs.stringify({ api_key: API_KEY, type: 'prabayar' }), config);
        
        // Langsung kirim full response (termasuk img_url) ke frontend
        res.json(response.data);
    } catch (error) {
        console.error("Error fetching services:", error.message);
        res.status(500).json({ status: false, message: "Gagal ambil data" });
    }
});

// 2. Create Payment
app.post('/api/create-payment', async (req, res) => {
    const { service_code, target, price_original } = req.body;
    
    // Profit margin logic
    const modal = parseInt(price_original);
    const nominalBayar = Math.ceil((modal + 700) / 0.986);
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

// 3. Check Status
app.post('/api/check-status', async (req, res) => {
    const { deposit_id, meta } = req.body;
    try {
        const statusRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/status`,
            qs.stringify({ api_key: API_KEY, id: deposit_id }), config);
        
        let status = statusRes.data.data.status;

        // Auto process jika processing
        if (status === 'processing') {
            try {
                await axios.post(`${ATLANTIC_BASE_URL}/deposit/instant`,
                    qs.stringify({ api_key: API_KEY, id: deposit_id, action: 'true' }), config);
                // Kita anggap success dulu agar lanjut cek transaksi, atau tunggu hit berikutnya
                status = 'success'; 
            } catch (e) {}
        }

        if (status === 'success') {
            const trxReff = `TRX-${deposit_id}`;
            const buyRes = await axios.post(`${ATLANTIC_BASE_URL}/transaksi/create`,
                qs.stringify({
                    api_key: API_KEY, code: meta.code, target: meta.target, reff_id: trxReff
                }), config);

            if (buyRes.data.status) {
                res.json({ status: true, state: 'success', sn: buyRes.data.data.sn });
            } else {
                if(buyRes.data.message.includes('uplicate') || buyRes.data.message.includes('sudah ada')) {
                    res.json({ status: true, state: 'success', sn: 'Sedang Diproses / Cek History' });
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

// 4. Cancel Payment
app.post('/api/cancel-payment', async (req, res) => {
    const { deposit_id } = req.body;
    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/deposit/cancel`,
            qs.stringify({ api_key: API_KEY, id: deposit_id }), config);
        res.json(response.data);
    } catch (error) {
        res.json({ status: true, message: "Force closed locally" });
    }
});

module.exports = app;
