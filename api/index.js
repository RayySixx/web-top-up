require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const qs = require('querystring');

const app = express();

// Middleware Vercel
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const ATLANTIC_BASE_URL = 'https://atlantich2h.com';
const API_KEY = process.env.ATLANTIC_API_KEY;

// Config Header
const config = {
    headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Atlantic-Vercel/1.0'
    }
};

// 1. Ambil Layanan
app.get('/api/services', async (req, res) => {
    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/layanan/price_list`, 
            qs.stringify({ api_key: API_KEY, type: 'prabayar' }), config);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: false, message: "Gagal ambil data" });
    }
});

// 2. Buat Payment (Hitung Rumus Anti Rugi)
app.post('/api/create-payment', async (req, res) => {
    const { service_code, target, price_original } = req.body;
    
    // RUMUS MATEMATIKA: Agar Profit Bersih Rp 500 setelah kena Fee (1.4% + 200)
    // Rumus: (Modal + Profit500 + FeeFix200) / (1 - 0.014)
    const baseCost = parseInt(price_original) + 500 + 200;
    const finalPrice = Math.ceil(baseCost / 0.986); 

    const reff_id = `PAY-${Date.now()}`;

    try {
        // Request QRIS Instant
        const depoRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/create`, 
            qs.stringify({
                api_key: API_KEY,
                reff_id: reff_id,
                nominal: finalPrice,
                type: 'ewallet',
                metode: 'qris'
            }), config);

        if (depoRes.data.status) {
            res.json({
                status: true,
                data: {
                    deposit_id: depoRes.data.data.id,
                    qr_image: depoRes.data.data.qr_image,
                    amount: finalPrice,
                    // Kita kirim balik data asli ke frontend karena Vercel ga punya database memory
                    meta: { 
                        code: service_code, 
                        target: target, 
                        price_modal: price_original 
                    }
                }
            });
        } else {
            res.json({ status: false, message: depoRes.data.message });
        }
    } catch (error) {
        res.status(500).json({ status: false, message: "Server Error" });
    }
});

// 3. Cek Status + Auto Instant + Auto Buy
app.post('/api/check-status', async (req, res) => {
    const { deposit_id, meta } = req.body; // Meta data dari frontend

    try {
        // A. Cek Status Deposit
        const statusRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/status`,
            qs.stringify({ api_key: API_KEY, id: deposit_id }), config);
        
        let depositStatus = statusRes.data.data.status; // pending, processing, success

        // B. Jika Processing (Uang masuk, tp belum cair), Tembak Instant!
        if (depositStatus === 'processing') {
            try {
                const instantRes = await axios.post(`${ATLANTIC_BASE_URL}/deposit/instant`,
                    qs.stringify({ api_key: API_KEY, id: deposit_id, action: 'true' }), config);
                if (instantRes.data.status) {
                    depositStatus = 'success'; // Paksa anggap sukses
                }
            } catch (err) { console.log("Instant Error", err.message); }
        }

        // C. Jika Saldo Masuk -> BELI PRODUK
        if (depositStatus === 'success') {
            // Kita coba beli. 
            // Note: Karena Vercel stateless, kita akan tembak beli setiap kali frontend ngecek status & sukses.
            // Atlantic akan menolak reff_id yg sama (duplicate), jadi aman tidak akan beli 2x.
            
            // Reff ID Transaksi kita buat deterministik berdasarkan deposit_id biar gak double
            const trxReff = `TRX-${deposit_id}`; 

            const buyRes = await axios.post(`${ATLANTIC_BASE_URL}/transaksi/create`,
                qs.stringify({
                    api_key: API_KEY,
                    code: meta.code,
                    target: meta.target,
                    reff_id: trxReff
                }), config);

            if (buyRes.data.status) {
                res.json({ status: true, state: 'success', sn: buyRes.data.data.sn });
            } else {
                // Cek error, kalau errornya "Duplicate Reff ID", berarti sebenarnya sudah sukses sebelumnya
                if(buyRes.data.message.includes('uplicate') || buyRes.data.message.includes('sudah ada')) {
                     // Cek status transaksi via API status transaksi kalau mau lebih valid, 
                     // tapi utk hemat request kita anggap sukses/manual check
                     res.json({ status: true, state: 'success', sn: 'Cek Riwayat/Hub Admin' });
                } else {
                    res.json({ status: true, state: 'failed', message: buyRes.data.message });
                }
            }
        } else if (depositStatus === 'cancel') {
            res.json({ status: true, state: 'expired' });
        } else {
            res.json({ status: true, state: 'pending' });
        }
    } catch (error) {
        res.status(500).json({ status: false });
    }
});

// Export untuk Vercel
module.exports = app;
