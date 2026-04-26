require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

let db;
async function connectDB() {
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });
        console.log('Conectado a la base de datos SQL');
    } catch (error) {
        console.error('Error al conectar a la DB:', error.message);
    }
}
connectDB();

app.post('/api/register', async (req, res) => {
    const { username, email, password, gender, birthdate, mathAnswer, n1, n2 } = req.body;

    // Validación del reto matemático en el servidor
    if (parseInt(mathAnswer) !== (parseInt(n1) + parseInt(n2))) {
        return res.status(400).json({ message: 'Error de verificación humana: Respuesta matemática incorrecta.' });
    }

    const birthDateObj = new Date(birthdate);
    const today = new Date();
    let age = today.getFullYear() - birthDateObj.getFullYear();
    const m = today.getMonth() - birthDateObj.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDateObj.getDate())) {
        age--;
    }

    if (age < 16) {
        return res.status(400).json({ message: 'Debes ser mayor de 16 años para registrarte.' });
    }

    try {
        if (!db) throw new Error('DB no conectada');
        const [existing] = await db.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) return res.status(400).json({ message: 'El usuario o el correo ya están registrados.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.execute(
            'INSERT INTO users (username, email, password, gender, birthdate, age) VALUES (?, ?, ?, ?, ?, ?)',
            [username, email, hashedPassword, gender, birthdate, age]
        );
        await db.execute('INSERT INTO profiles (user_id) VALUES (?)', [result.insertId]);
        res.status(201).json({ message: 'Usuario registrado con éxito.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor al registrar.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (!db) throw new Error('DB no conectada');
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(400).json({ message: 'Credenciales incorrectas.' });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Credenciales incorrectas.' });

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                is_premium: user.is_premium,
                partner_id: user.partner_id
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor al iniciar sesión.' });
    }
});

// Ruta para recuperar contraseña con SendGrid
app.post('/api/recover-password', async (req, res) => {
    const { email } = req.body;

    try {
        if (!db) throw new Error('DB no conectada');
        const [users] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);

        if (users.length > 0) {
            const transporter = nodemailer.createTransport({
                host: 'smtp.sendgrid.net',
                port: 587,
                auth: {
                    user: 'apikey',
                    pass: process.env.SENDGRID_API_KEY
                }
            });

            const mailOptions = {
                from: process.env.EMAIL_FROM,
                to: email,
                subject: 'Recuperación de Contraseña - AmourApp',
                text: 'Has solicitado restablecer tu contraseña. Haz clic en el siguiente enlace para continuar con el proceso (Simulación).'
            };

            await transporter.sendMail(mailOptions);
        }

        res.json({ message: 'Si el correo existe, se ha enviado un enlace de recuperación.' });
    } catch (error) {
        console.error('Error en SendGrid:', error);
        res.status(500).json({ message: 'Error al procesar la solicitud.' });
    }
});

// Middleware de autenticación simple
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// Búsqueda de usuarios para pareja
app.get('/api/users/search', authenticateToken, async (req, res) => {
    const { q } = req.query;
    try {
        if (!db) throw new Error('DB no conectada');
        // Buscamos usuarios que no tengan pareja y que no sean el usuario actual
        const [users] = await db.execute(
            'SELECT id, username FROM users WHERE username LIKE ? AND id != ? AND partner_id IS NULL LIMIT 10',
            [`%${q}%`, req.user.id]
        );
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Error en la búsqueda.' });
    }
});

// Enviar solicitud de pareja
app.post('/api/partner-requests/send', authenticateToken, async (req, res) => {
    const { receiverId } = req.body;
    try {
        if (!db) throw new Error('DB no conectada');

        // Verificar si el remitente ya tiene pareja
        const [me] = await db.execute('SELECT partner_id FROM users WHERE id = ?', [req.user.id]);
        if (me[0].partner_id) return res.status(400).json({ message: 'Ya tienes una pareja.' });

        // Insertar solicitud
        await db.execute(
            'INSERT INTO partner_requests (sender_id, receiver_id) VALUES (?, ?)',
            [req.user.id, receiverId]
        );
        res.json({ message: 'Solicitud enviada.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al enviar solicitud.' });
    }
});

// Ver solicitudes pendientes
app.get('/api/partner-requests/pending', authenticateToken, async (req, res) => {
    try {
        if (!db) throw new Error('DB no conectada');
        const [requests] = await db.execute(
            'SELECT pr.id, u.username, u.id as sender_id FROM partner_requests pr JOIN users u ON pr.sender_id = u.id WHERE pr.receiver_id = ? AND pr.status = "pending"',
            [req.user.id]
        );
        res.json(requests);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener solicitudes.' });
    }
});

// Aceptar/Rechazar solicitud
app.post('/api/partner-requests/respond', authenticateToken, async (req, res) => {
    const { requestId, action } = req.body; // action: 'accept' o 'reject'
    try {
        if (!db) throw new Error('DB no conectada');

        if (action === 'accept') {
            const [reqData] = await db.execute('SELECT sender_id FROM partner_requests WHERE id = ?', [requestId]);
            const senderId = reqData[0].sender_id;

            // Actualizar ambos usuarios
            await db.execute('UPDATE users SET partner_id = ? WHERE id = ?', [senderId, req.user.id]);
            await db.execute('UPDATE users SET partner_id = ? WHERE id = ?', [req.user.id, senderId]);

            // Marcar solicitud como aceptada
            await db.execute('UPDATE partner_requests SET status = "accepted" WHERE id = ?', [requestId]);

            // Cancelar otras solicitudes pendientes de ambos
            await db.execute('DELETE FROM partner_requests WHERE (sender_id = ? OR receiver_id = ?) AND status = "pending"', [req.user.id, req.user.id]);
            await db.execute('DELETE FROM partner_requests WHERE (sender_id = ? OR receiver_id = ?) AND status = "pending"', [senderId, senderId]);

            res.json({ message: '¡Ahora son pareja!' });
        } else {
            await db.execute('UPDATE partner_requests SET status = "rejected" WHERE id = ?', [requestId]);
            res.json({ message: 'Solicitud rechazada.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error al responder solicitud.' });
    }
});

// Enviar mensaje de chat
app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { content } = req.body;
    try {
        if (!db) throw new Error('DB no conectada');

        // Validar caracteres
        if (!content || content.length > 500) {
            return res.status(400).json({ message: 'El mensaje no puede exceder los 500 caracteres.' });
        }

        // Obtener pareja
        const [me] = await db.execute('SELECT partner_id FROM users WHERE id = ?', [req.user.id]);
        if (!me[0].partner_id) return res.status(400).json({ message: 'No tienes una pareja vinculada.' });

        await db.execute(
            'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
            [req.user.id, me[0].partner_id, content]
        );
        res.json({ message: 'Mensaje enviado.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al enviar mensaje.' });
    }
});

// Obtener historial de chat
app.get('/api/chat/history', authenticateToken, async (req, res) => {
    try {
        if (!db) throw new Error('DB no conectada');

        const [me] = await db.execute('SELECT partner_id FROM users WHERE id = ?', [req.user.id]);
        if (!me[0].partner_id) return res.json([]);

        const [messages] = await db.execute(
            'SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY sent_at ASC LIMIT 50',
            [req.user.id, me[0].partner_id, me[0].partner_id, req.user.id]
        );
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar chat.' });
    }
});

// Enviar carta animada
app.post('/api/letters/send', authenticateToken, async (req, res) => {
    const { content, youtubeLink } = req.body;
    try {
        if (!db) throw new Error('DB no conectada');

        if (!content || content.length > 500) {
            return res.status(400).json({ message: 'La carta no puede exceder los 500 caracteres.' });
        }

        const [me] = await db.execute('SELECT partner_id FROM users WHERE id = ?', [req.user.id]);
        if (!me[0].partner_id) return res.status(400).json({ message: 'No tienes una pareja vinculada.' });

        await db.execute(
            'INSERT INTO letters (sender_id, recipient_id, content, youtube_link) VALUES (?, ?, ?, ?)',
            [req.user.id, me[0].partner_id, content, youtubeLink]
        );
        res.json({ message: '¡Carta enviada y en camino!' });
    } catch (error) {
        res.status(500).json({ message: 'Error al enviar la carta.' });
    }
});

// Ver cartas recibidas
app.get('/api/letters/received', authenticateToken, async (req, res) => {
    try {
        if (!db) throw new Error('DB no conectada');
        const [letters] = await db.execute(
            'SELECT l.*, u.username as sender_name FROM letters l JOIN users u ON l.sender_id = u.id WHERE l.recipient_id = ? ORDER BY l.sent_at DESC',
            [req.user.id]
        );
        res.json(letters);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar cartas.' });
    }
});

app.get('/:page', (req, res, next) => {
    const page = req.params.page;
    if (page.endsWith('.html')) {
        res.sendFile(path.join(__dirname, '../public', page));
    } else {
        next();
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
