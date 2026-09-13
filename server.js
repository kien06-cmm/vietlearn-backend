const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// --- API Xử lý Bóc tách tài liệu (PDF/Word/Forms) ---
app.post('/api/extract-questions', async (req, res) => {
    try {
        const { source, mimeType, fileBase64, formsUrl } = req.body;
        console.log("Đã nhận yêu cầu xử lý từ frontend:", source);
        
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Sử dụng model Gemini 3.5 Flash Lite siêu tốc
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.5-flash-lite",
            systemInstruction: `Bạn là trợ lý AI chuyên phân tích tài liệu giáo dục. Nhiệm vụ của bạn là bóc tách các câu hỏi trong tài liệu và trả về MỘT MẢNG JSON duy nhất chứa các câu hỏi theo đúng định dạng sau:
[
  {
    "question": "Nội dung câu hỏi",
    "type": "multiple_choice" | "essay" | "true_false",
    "subject": "Tên môn học",
    "grade": "Khối lớp (ví dụ: 10, 11, 12)",
    "difficulty": "easy" | "medium" | "hard",
    "score": 1,
    "answers": [{"text": "Đáp án A", "correct": true}, {"text": "Đáp án B", "correct": false}] (Dùng cho trắc nghiệm),
    "essayAnswer": "Đáp án tự luận mẫu" (Dùng cho tự luận)
  }
]
TUYỆT ĐỐI CHỈ TRẢ VỀ CHUỖI JSON, KHÔNG BỌC TRONG KÝ HIỆU MARKDOWN HAY GIẢI THÍCH.`
        });

        let promptText = "";
        let requestContent = [];

        if (source === 'file' && fileBase64) {
            promptText = "Hãy bóc tách tất cả các câu hỏi có trong tài liệu đính kèm này.";
            requestContent = [
                promptText,
                {
                    inlineData: {
                        data: fileBase64,
                        mimeType: mimeType || "application/pdf"
                    }
                }
            ];
        } else if (source === 'google-forms' && formsUrl) {
             promptText = `Hãy phân tích đường link Google Forms sau đây và bóc tách các câu hỏi: ${formsUrl}`;
             requestContent = [promptText];
        } else {
             return res.status(400).json({ message: "Thiếu dữ liệu đầu vào (file hoặc link)." });
        }

        const result = await model.generateContent(requestContent);
        let text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        
        // Trả về đúng định dạng { questions: [...] } mà Frontend yêu cầu
        res.json({ questions: JSON.parse(text) });

    } catch (error) {
        console.error("Lỗi bóc tách tài liệu:", error);
        res.status(500).json({ message: "Lỗi server khi bóc tách tài liệu." });
    }
});

// --- API Xử lý biên dịch Toán học ---
app.post('/api/compile-math', async (req, res) => {
    try {
        const { input } = req.body;
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Đồng bộ model 3.5 Flash Lite cho phần Toán học
        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash-lite",
            systemInstruction: "Bạn là bộ chuyển đổi công thức Toán học sang mã LaTeX. CHỈ TRẢ VỀ JSON THUẦN TÚY với cấu trúc: {\"ok\": true, \"type\": \"math\"|\"chemistry\", \"latex\": \"mã_latex\"}. KHÔNG bọc trong markdown hay ký hiệu $ hay $$. TUYỆT ĐỐI không chào hỏi hay giải thích."
        });
        const result = await model.generateContent(input);
        let text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (error) {
        console.error("Lỗi biên dịch Toán:", error);
        res.status(500).json({ ok: false, error: "Lỗi server khi biên dịch toán." });
    }
});

// Lệnh này bắt buộc phải có để server không bị "thoát sớm"
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});