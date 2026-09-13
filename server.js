const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Tăng giới hạn dung lượng để upload file không bị lỗi
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Bắt buộc: Lấy Port từ Render cấp, nếu không có thì dùng 3000
const PORT = process.env.PORT || 3000;

// Đường dẫn kiểm tra xem server có hoạt động không
app.get('/', (req, res) => {
    res.send('🚀 VietLearn Backend API đang hoạt động mượt mà!');
});

// Đường dẫn API bóc tách tài liệu (Claude sẽ gọi vào đây)
app.post('/api/extract-questions', async (req, res) => {
    try {
        const { source, mimeType, fileBase64, formsUrl } = req.body;
        console.log("Đã nhận yêu cầu xử lý từ frontend:", source);
        
        // TODO: Chèn logic gọi các file lib/gemini.js vào đây sau
        res.json({ questions: [{ question: "Server đã nhận được API thành công!" }]});
    } catch (error) {
        console.error("Lỗi:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lệnh này bắt buộc phải có để server không bị "thoát sớm"
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});