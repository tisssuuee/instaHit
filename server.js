const express = require('express');
const fetch = require('node-fetch').default;
const jsdom = require('jsdom');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const puppeteer = require(process.env.ON_RENDER ? 'puppeteer-core' : 'puppeteer');
const { JSDOM } = jsdom;

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch with cookie persistence
const fetchWithCookies = async (url, options = {}, cookies = {}, retries = 3) => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
    ];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const headers = {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'referer': 'https://indown.io/',
            'origin': 'https://indown.io',
            'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            ...options.headers,
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
        console.log(`Fetch ${url}: Status ${response.status}, Cookies:`, newCookies);
        return { response, cookies: newCookies };
    } catch (error) {
        if (retries > 0 && (error.message.includes('403') || error.message.includes('429'))) {
            console.log(`Retrying ${url}, retries left: ${retries}, error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return fetchWithCookies(url, options, cookies, retries - 1);
        }
        throw error.name === 'AbortError' ? new Error('Request timed out') : error;
    } finally {
        clearTimeout(timeoutId);
    }
};

// Helper to parse profile data
const parseProfileData = (html) => {
    const dom = new JSDOM(html);
    const profileBox = dom.window.document.querySelector('.profile-box');
    if (!profileBox) {
        return null;
    }
    const originalImage = profileBox.querySelector('.profile-container img')?.src || '';
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

// Cache for token and cookies
let tokenCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// API to fetch token
app.get('/api/fetch-token', async (req, res) => {
    console.log('Fetching token from indown.io');
    try {
        const now = Date.now();
        if (tokenCache && now - cacheTimestamp < CACHE_DURATION) {
            console.log('Returning cached token');
            return res.json(tokenCache);
        }

        const isMac = os.platform() === 'darwin';
        const launchOptions = {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            headless: 'new'
        };

        if (process.env.ON_RENDER) {
            launchOptions.executablePath = '/usr/bin/chromium';
        } else if (isMac) {
            launchOptions.executablePath = process.env.CHROMIUM_PATH || '/opt/homebrew/bin/chromium' || '/usr/local/bin/chromium';
        } else {
            launchOptions.executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
        }

        // If not Render, let puppeteer handle Chromium locally
        if (!process.env.ON_RENDER) {
            delete launchOptions.executablePath; // Let puppeteer download/use default
        }

        console.log('Puppeteer launch options:', launchOptions);
        const browser = await puppeteer.launch(launchOptions);
        try {
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9'
            });

            console.log('Navigating to https://indown.io/insta-dp-viewer');
            const response = await page.goto('https://indown.io/insta-dp-viewer', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            if (!response.ok()) {
                throw new Error(`Page load failed: ${response.status()}`);
            }

            const token = await page.evaluate(() => {
                const input = document.querySelector('input[name="_token"]');
                return input ? input.value : null;
            });
            if (!token) {
                throw new Error('Token input not found');
            }

            const cookies = await page.cookies();
            const cookieObj = cookies.reduce((acc, cookie) => {
                acc[cookie.name] = cookie.value;
                return acc;
            }, {});

            console.log('Token and cookies fetched:', { token, cookies: cookieObj });

            tokenCache = { token, cookies: cookieObj };
            cacheTimestamp = now;

            res.json(tokenCache);
        } finally {
            await browser.close();
        }
    } catch (error) {
        console.error('Token fetch error:', error.stack);
        res.status(500).json({ error: `Failed to fetch token: ${error.message}` });
    }
});

// API to fetch profile
app.post('/api/fetch-profile', async (req, res) => {
    const { url, token, cookies = {} } = req.body;
    console.log('Fetch profile request:', { url, token, cookies });

    if (!url || !url.match(/^https:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/)) {
        console.log('Invalid Instagram URL:', url);
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }
    if (!token) {
        console.log('Missing token');
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

            console.log(`Attempt ${attempt + 1}: Posting to indown.io/download`);
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

            // Handle non-302 responses
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
            console.log('Following redirect to indown.io/insta-dp-viewer');
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

            console.log('Profile data fetched successfully');
            res.json(profileData);
            return;
        } catch (error) {
            console.error(`Attempt ${attempt + 1} error:`, error.message, error.stack);
            if (attempt + 1 === maxRetries) {
                console.log('All retries failed');
                res.status(500).json({ error: `Failed to fetch profile: ${error.message}` });
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