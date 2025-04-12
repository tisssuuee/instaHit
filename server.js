const express = require('express');
const fetch = require('node-fetch');
const jsdom = require('jsdom');
const cookieParser = require('cookie-parser');
const path = require('path');
const { JSDOM } = jsdom;

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch with cookie persistence
const fetchWithCookies = async (url, options = {}, cookies = {}) => {
    const headers = {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...options.headers,
    };
    if (Object.keys(cookies).length) {
        headers['cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const response = await fetch(url, { ...options, headers });
    const setCookies = response.headers.raw()['set-cookie'] || [];
    const newCookies = {};
    setCookies.forEach(cookie => {
        const [nameValue] = cookie.split(';');
        const [name, value] = nameValue.split('=');
        newCookies[name] = value;
    });
    return { response, cookies: newCookies };
};

// Helper to parse profile data
const parseProfileData = (html) => {
    const dom = new JSDOM(html);
    const profileBox = dom.window.document.querySelector('.profile-box');
    if (!profileBox) {
        return null;
    }
    const originalImage = profileBox.querySelector('.profile-container img')?.src || '';
    // Use proxied image URL
    const image = originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}` : '/placeholder.jpg';
    const viewUrl = profileBox.querySelector('.profile-button a[href*="instagram.f"]')?.href || '#';
    return {
        image,
        viewUrl,
        downloadUrl: originalImage ? `/api/proxy-image?url=${encodeURIComponent(originalImage)}&download=true` : '#',
        fullName: profileBox.querySelector('h3')?.textContent || 'Unknown',
        username: profileBox.querySelector('.title')?.textContent || '@unknown',
        bio: profileBox.querySelector('p:not(.title)')?.textContent || 'No bio available',
        followers: profileBox.querySelector('table tr:nth-child(1) td')?.textContent || '0',
        isPrivate: profileBox.querySelector('table tr:nth-child(2) td')?.textContent || 'Unknown',
        isVerified: profileBox.querySelector('table tr:nth-child(3) td')?.textContent || 'Unknown',
    };
};

// API to proxy images
app.get('/api/proxy-image', async (req, res) => {
    const { url, download } = req.query;
    if (!url) {
        return res.status(400).send('Image URL required');
    }
    try {
        const response = await fetch(decodeURIComponent(url), {
            headers: {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.set('Content-Type', contentType);
        if (download === 'true') {
            res.set('Content-Disposition', 'attachment; filename="profile.jpg"');
        }
        const buffer = await response.buffer();
        res.send(buffer);
    } catch (error) {
        console.error('Image proxy error:', error);
        res.status(500).send('Failed to fetch image');
    }
});

// API to fetch token
app.get('/api/fetch-token', async (req, res) => {
    try {
        const { response, cookies } = await fetchWithCookies('https://indown.io/insta-dp-viewer');
        const html = await response.text();
        if (!response.ok) {
            console.error('Token fetch response:', { status: response.status, body: html.substring(0, 500) });
            throw new Error(`Token fetch failed: ${response.status}`);
        }
        const dom = new JSDOM(html);
        const tokenInput = dom.window.document.querySelector('input[name="_token"]');
        if (!tokenInput) {
            console.error('Token fetch HTML sample:', html.substring(0, 500));
            throw new Error('Token input not found');
        }
        res.json({ token: tokenInput.value, cookies });
    } catch (error) {
        console.error('Token fetch error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API to fetch profile
app.post('/api/fetch-profile', async (req, res) => {
    const { url, token, cookies = {} } = req.body;
    if (!url || !url.match(/^https:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/)) {
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            // Step 1: Submit URL
            const formData = new URLSearchParams();
            formData.append('referer', 'https://indown.io/insta-dp-viewer');
            formData.append('locale', 'en');
            formData.append('i', '2001:4860:7:405::a4');
            formData.append('_token', token);
            formData.append('link', url);

            const postResponse = await fetchWithCookies('https://indown.io/download', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: formData,
            }, cookies);

            const postHtml = await postResponse.response.text();
            console.log('POST response status:', postResponse.response.status);

            // Check if POST response contains profile data
            let profileData = parseProfileData(postHtml);
            if (profileData) {
                console.log('Profile data found in POST response');
                return res.json(profileData);
            }

            // Expect 302, but handle other cases
            if (postResponse.response.status !== 302) {
                console.error('POST response body:', postHtml.substring(0, 500));
                if (postResponse.response.status === 429) {
                    attempt++;
                    console.log(`Rate limited, retrying (${attempt}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
                throw new Error(`POST failed: ${postResponse.response.status}`);
            }

            // Step 2: Fetch profile data
            const profileResponse = await fetchWithCookies('https://indown.io/insta-dp-viewer', {}, postResponse.cookies);
            const profileHtml = await profileResponse.response.text();
            console.log('GET response status:', profileResponse.response.status);

            if (!profileResponse.response.ok) {
                console.error('GET response body:', profileHtml.substring(0, 500));
                throw new Error(`Profile fetch failed: ${profileResponse.response.status}`);
            }

            profileData = parseProfileData(profileHtml);
            if (!profileData) {
                console.error('Profile HTML sample:', profileHtml.substring(0, 500));
                throw new Error('Profile data not found');
            }

            res.json(profileData);
            return;
        } catch (error) {
            console.error('Attempt', attempt + 1, 'error:', error);
            if (attempt + 1 === maxRetries) {
                res.status(500).json({ error: error.message });
            }
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/home.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/contact.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});