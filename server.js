const express = require('express');
const fetch = require('node-fetch');
const jsdom = require('jsdom');
const cookieParser = require('cookie-parser');
const path = require('path');
const cors = require('cors');
const { JSDOM } = jsdom;

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: 'https://instahit.onrender.com', credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

const fetchWithCookies = async (url, options = {}, cookies = {}, retries = 3) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const headers = {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            ...options.headers
        };
        if (Object.keys(cookies).length) {
            headers['cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        const setCookies = response.headers.raw()['set-cookie'] || [];
        const newCookies = {};
        setCookies.forEach(cookie => {
            const [nameValue] = cookie.split(';');
            const [name, value] = nameValue.split('=');
            newCookies[name] = value;
        });
        return { response, cookies: newCookies };
    } catch (error) {
        if (retries > 0 && error.name !== 'AbortError') {
            await new Promise(resolve => setTimeout(resolve, 1500));
            return fetchWithCookies(url, options, cookies, retries - 1);
        }
        throw error.name === 'AbortError' ? new Error('Request timed out') : error;
    } finally {
        clearTimeout(timeoutId);
    }
};

const normalizeUrl = (url) => {
    const cleanUrl = url.trim().split('?')[0].replace(/\/+$/, '');
    return cleanUrl + '/';
};

const parseProfileData = (html) => {
    const dom = new JSDOM(html);
    const profileBox = dom.window.document.querySelector('.profile-box');
    if (!profileBox) return null;
    const images = profileBox.querySelectorAll('.profile-container img');
    let originalImage = '';
    images.forEach(img => {
        const src = img.src;
        if (src.includes('fbcdn.net') && (src.includes('profile_pic') || src.includes('2885-19') || src.includes('s150x150'))) {
            originalImage = src;
        }
    });
    if (!originalImage) {
        const fallbackImg = profileBox.querySelector('.profile-container img.rounded-circle')?.src || '';
        if (fallbackImg && !fallbackImg.includes('blurred-profile.jpg') && !fallbackImg.includes('default.jpg')) {
            originalImage = fallbackImg;
        }
    }
    const image = originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}` : '/placeholder.jpg';
    return {
        image,
        viewUrl: image,
        downloadUrl: originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}&download=true` : '#',
        fullName: profileBox.querySelector('h3')?.textContent || 'Unknown',
        username: profileBox.querySelector('.title')?.textContent || '@unknown',
        bio: profileBox.querySelector('p:not(.title)')?.textContent || 'No bio available',
        followers: profileBox.querySelector('table tr:nth-child(1) td')?.textContent || '0',
        isPrivate: profileBox.querySelector('table tr:nth-child(2) td')?.textContent || 'Unknown',
        isVerified: profileBox.querySelector('table tr:nth-child(3) td')?.textContent || 'Unknown'
    };
};

app.get('/api/proxy-image', async (req, res) => {
    const { url, download } = req.query;
    if (!url) return res.status(400).send('Image URL required');
    try {
        const response = await fetch(decodeURIComponent(url), {
            headers: { 'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] }
        });
        if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.set('Content-Type', contentType);
        if (download === 'true') {
            res.set('Content-Disposition', 'attachment; filename="profile.jpg"');
        }
        const buffer = await response.buffer();
        res.send(buffer);
    } catch (error) {
        res.status(500).send('Failed to fetch image');
    }
});

app.get('/api/fetch-token', async (req, res) => {
    console.log('Fetching token from indown.io');
    try {
        const { response, cookies } = await fetchWithCookies('https://indown.io/insta-dp-viewer');
        if (!response.ok) {
            const text = await response.text();
            console.log('Token fetch failed:', response.status, text.slice(0, 200));
            throw new Error(`Token fetch failed: ${response.status}`);
        }
        const text = await response.text();
        const dom = new JSDOM(text);
        const tokenInput = dom.window.document.querySelector('input[name="_token"]');
        if (!tokenInput) {
            console.log('Token input not found:', text.slice(0, 200));
            throw new Error('Token input not found');
        }
        res.json({ token: tokenInput.value, cookies });
    } catch (error) {
        console.log('Token fetch error:', error.message);
        res.status(500).json({ error: `Failed to fetch token: ${error.message}` });
    }
});

app.post('/api/fetch-profile', async (req, res) => {
    let { url, token, cookies = {} } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    url = normalizeUrl(url);
    if (!url.match(/^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/$/)) {
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }
    if (!token) return res.status(400).json({ error: 'Token required' });

    try {
        const formData = new URLSearchParams();
        formData.append('referer', 'https://indown.io/insta-dp-viewer');
        formData.append('locale', 'en');
        formData.append('i', '2001:4860:7:405::a4');
        formData.append('_token', token);
        formData.append('link', url);

        const postResponse = await fetchWithCookies('https://indown.io/download', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: formData
        }, cookies);

        const contentType = postResponse.response.headers.get('content-type') || '';
        const postText = await postResponse.response.text();

        if (!contentType.includes('text/html')) {
            throw new Error(`Unexpected content type: ${contentType}`);
        }
        if (!postResponse.response.ok) {
            throw new Error(`POST failed: ${postResponse.response.status} - ${postText.slice(0, 200)}`);
        }

        let profileData = parseProfileData(postText);
        if (profileData) return res.json(profileData);

        if (postResponse.response.status === 302) {
            const profileResponse = await fetchWithCookies('https://indown.io/insta-dp-viewer', {}, postResponse.cookies);
            const profileContentType = profileResponse.response.headers.get('content-type') || '';
            const profileText = await profileResponse.response.text();

            if (!profileContentType.includes('text/html')) {
                throw new Error(`Unexpected profile content type: ${profileContentType}`);
            }
            if (!profileResponse.response.ok) {
                throw new Error(`GET failed: ${profileResponse.response.status} - ${profileText.slice(0, 200)}`);
            }

            profileData = parseProfileData(profileText);
            if (!profileData) throw new Error('No profile data found');
            res.json(profileData);
        } else {
            throw new Error('No profile data in response');
        }
    } catch (error) {
        res.status(500).json({ error: `Failed to fetch profile: ${error.message}` });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/home.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/about.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/contact.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));

app.listen(port, () => console.log(`Server on port ${port}`));