require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

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
    const { username, email, password, gender, birthdate, mathAnswer, mathExpected } = req.body;

    if (parseInt(mathAnswer) !== parseInt(mathExpected)) {
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

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });
        res.json({ token, user: { id: user.id, username: user.username, is_premium: user.is_premium } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor al iniciar sesión.' });
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
