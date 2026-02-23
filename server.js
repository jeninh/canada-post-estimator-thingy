require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const CP_RATE_ENDPOINT = process.env.CP_ENVIRONMENT === 'production'
  ? 'https://soa-gw.canadapost.ca/rs/ship/price'
  : 'https://ct.soa-gw.canadapost.ca/rs/ship/price';

let cachedExchangeRate = null;
let cacheTimestamp = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

async function getCADtoUSDRate() {
  // Return cached rate if still valid
  if (cachedExchangeRate && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION_MS)) {
    return cachedExchangeRate;
  }

  try {
    const today = new Date();
    const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    
    const url = `https://www.visa.ca/cmsapi/fx/rates?amount=1&fee=0&utcConvertedDate=${encodeURIComponent(dateStr)}&exchangedate=${encodeURIComponent(dateStr)}&fromCurr=CAD&toCurr=USD`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Visa FX API error:', response.status);
      return cachedExchangeRate || 0.73;
    }

    const data = await response.json();
    const rate = parseFloat(data.originalValues?.fxRateVisa || data.fxRateWithAdditionalFee);
    
    cachedExchangeRate = rate;
    cacheTimestamp = Date.now();
    
    console.log('Visa FX rate CAD->USD:', rate);
    return rate;
  } catch (err) {
    console.error('Visa FX API call failed:', err.message);
    return cachedExchangeRate || 0.73;
  }
}

function buildDestinationXML(country, postalCode) {
  if (country === 'CA') {
    return `<domestic>
      <postal-code>${postalCode.replace(/\s/g, '').toUpperCase()}</postal-code>
    </domestic>`;
  } else if (country === 'US') {
    return `<united-states>
      <zip-code>${postalCode.replace(/\s/g, '')}</zip-code>
    </united-states>`;
  } else {
    if (postalCode) {
      return `<international>
      <country-code>${country}</country-code>
      <postal-code>${postalCode}</postal-code>
    </international>`;
    }
    return `<international>
      <country-code>${country}</country-code>
    </international>`;
  }
}

function buildRateRequestXML(originPostal, country, postalCode, weight, length, width, height) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mailing-scenario xmlns="http://www.canadapost.ca/ws/ship/rate-v4">
  <customer-number>${process.env.CP_CUSTOMER_NUMBER}</customer-number>
  ${process.env.CP_CONTRACT_ID ? `<contract-id>${process.env.CP_CONTRACT_ID}</contract-id>` : ''}
  <parcel-characteristics>
    <weight>${weight}</weight>
    <dimensions>
      <length>${length}</length>
      <width>${width}</width>
      <height>${height}</height>
    </dimensions>
  </parcel-characteristics>
  <origin-postal-code>${originPostal.replace(/\s/g, '').toUpperCase()}</origin-postal-code>
  <destination>
    ${buildDestinationXML(country, postalCode)}
  </destination>
</mailing-scenario>`;
}

async function getRates(originPostal, country, postalCode, weight, length, width, height) {
  const authString = Buffer.from(
    `${process.env.CP_API_USERNAME}:${process.env.CP_API_PASSWORD}`
  ).toString('base64');

  const xmlBody = buildRateRequestXML(originPostal, country, postalCode, weight, length, width, height);

  console.log('Calling Canada Post API...');
  
  const response = await fetch(CP_RATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.cpc.ship.rate-v4+xml',
      'Accept': 'application/vnd.cpc.ship.rate-v4+xml',
      'Authorization': `Basic ${authString}`,
      'Accept-language': 'en-CA'
    },
    body: xmlBody
  });
  


  const xmlResponse = await response.text();

  if (!response.ok) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const errorResult = await parser.parseStringPromise(xmlResponse);
    throw new Error(JSON.stringify(errorResult));
  }

  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlResponse);

  return result;
}

async function formatRatesResponse(parsedXml, exchangeRate) {
  const priceQuotes = parsedXml['price-quotes'];
  if (!priceQuotes || !priceQuotes['price-quote']) {
    return [];
  }

  let quotes = priceQuotes['price-quote'];
  if (!Array.isArray(quotes)) {
    quotes = [quotes];
  }

  return quotes.map(quote => {
    const priceDetails = quote['price-details'];
    const taxes = priceDetails.taxes || {};
    const baseTotalCAD = parseFloat(priceDetails.due || 0);
    const handlingFee = 2.00;
    const totalCAD = baseTotalCAD + handlingFee;
    const totalUSD = Math.round(totalCAD * exchangeRate * 100) / 100;

    return {
      serviceName: quote['service-name'],
      serviceCode: quote['service-code'],
      priceDetails: {
        base: Math.round(parseFloat(priceDetails.base || 0) * exchangeRate * 100) / 100,
        gst: Math.round(parseFloat(taxes.gst?.$ || taxes.gst || 0) * exchangeRate * 100) / 100,
        pst: Math.round(parseFloat(taxes.pst?.$ || taxes.pst || 0) * exchangeRate * 100) / 100,
        hst: Math.round(parseFloat(taxes.hst?.$ || taxes.hst || 0) * exchangeRate * 100) / 100,
        total: totalUSD
      },
      deliveryDate: quote['service-standard']?.['expected-delivery-date'] || 'N/A',
      transitDays: quote['service-standard']?.['expected-transit-time'] || 'N/A',
      currency: 'USD'
    };
  });
}

function convertToKg(weight, unit) {
  switch (unit) {
    case 'g':
      return weight / 1000;
    case 'lb':
      return weight * 0.453592;
    case 'kg':
    default:
      return weight;
  }
}

function convertToGrams(weight, unit) {
  switch (unit) {
    case 'kg':
      return weight * 1000;
    case 'lb':
      return weight * 453.592;
    case 'g':
    default:
      return weight;
  }
}

function getLetterMailOptions(weightGrams, lengthCm, widthCm, heightCm, country) {
  const options = [];
  
  const lengthMm = lengthCm * 10;
  const widthMm = widthCm * 10;
  const heightMm = heightCm * 10;
  
  const meetsMinDimensions = lengthMm >= 140 && widthMm >= 90;
  const isStandardSize = lengthMm <= 245 && widthMm <= 156 && heightMm <= 5;
  const isOversizeSize = lengthMm <= 380 && widthMm <= 270 && heightMm <= 20;
  
  // Standard Lettermail (2-30g, standard dimensions, must meet minimums)
  if (meetsMinDimensions && isStandardSize && weightGrams <= 30 && weightGrams >= 2) {
    let price;
    if (country === 'CA') price = 1.75;
    else if (country === 'US') price = 2.00;
    else price = 3.50;
    
    const countryLabel = country === 'CA' ? 'Domestic' : country === 'US' ? 'USA' : 'International';
    options.push({
      serviceName: `Lettermail ${countryLabel} (up to 30g)`,
      serviceCode: 'LETTERMAIL.STD',
      priceDetails: { base: price, gst: 0, pst: 0, hst: 0, total: price },
      deliveryDate: 'N/A',
      transitDays: country === 'CA' ? '2-4' : country === 'US' ? '4-7' : '7-14',
      isLettermail: true,
      note: 'Max: 245mm x 156mm x 5mm'
    });
  }
  
  // Oversize Lettermail (5-500g, larger dimensions)
  if (isOversizeSize && weightGrams >= 5 && weightGrams <= 500) {
    let price;
    const countryLabel = country === 'CA' ? 'Domestic' : country === 'US' ? 'USA' : 'International';
    
    if (country === 'CA') {
      if (weightGrams <= 100) price = 3.11;
      else if (weightGrams <= 200) price = 4.51;
      else if (weightGrams <= 300) price = 5.91;
      else if (weightGrams <= 400) price = 6.62;
      else price = 7.05;
    } else if (country === 'US') {
      if (weightGrams <= 100) price = 4.51;
      else if (weightGrams <= 200) price = 7.16;
      else price = 13.38;
    } else {
      if (weightGrams <= 100) price = 8.08;
      else if (weightGrams <= 200) price = 13.38;
      else price = 25.80;
    }
    
    options.push({
      serviceName: `Bubble Packet ${countryLabel} (up to 500g)`,
      serviceCode: 'BUBBLE.PACKET',
      priceDetails: { base: price, gst: 0, pst: 0, hst: 0, total: price },
      deliveryDate: 'N/A',
      transitDays: country === 'CA' ? '2-5' : country === 'US' ? '5-10' : '10-21',
      isLettermail: true,
      note: 'Max: 380mm x 270mm x 20mm'
    });
  }
  
  return options;
}

app.post('/api/rates', async (req, res) => {
  try {
    const { country, street, city, province, postalCode, weight, weightUnit, length, width, height } = req.body;

    if (!country || !weight) {
      return res.status(400).json({ error: 'Country and weight are required' });
    }
    
    if (!street || !city || !province) {
      return res.status(400).json({ error: 'Full shipping info (street, city, province) is required' });
    }
    
    if (country === 'CA' && !postalCode) {
      return res.status(400).json({ error: 'Postal code is required for Canadian destinations' });
    }
    
    if (country === 'US' && !postalCode) {
      return res.status(400).json({ error: 'ZIP code is required for US destinations' });
    }

    const originPostal = process.env.ORIGIN_POSTAL_CODE;
    if (!originPostal) {
      return res.status(500).json({ error: 'Origin postal code not configured' });
    }

    const weightInKg = convertToKg(weight || 1, weightUnit || 'kg');
    const weightInGrams = convertToGrams(weight || 1, weightUnit || 'kg');
    const lengthVal = length || 10;
    const widthVal = width || 10;
    const heightVal = height || 10;

    const lettermailOptions = getLetterMailOptions(weightInGrams, lengthVal, widthVal, heightVal, country);

    let parcelRates = [];
    try {
      const exchangeRate = await getCADtoUSDRate();
      const result = await getRates(
        originPostal,
        country,
        postalCode,
        weightInKg,
        lengthVal,
        widthVal,
        heightVal
      );
      parcelRates = await formatRatesResponse(result, exchangeRate);
    } catch (err) {
      console.error('Parcel rate lookup failed:', err.message);
    }

    const allRates = [...lettermailOptions, ...parcelRates];
    
    res.json({ rates: allRates, origin: originPostal });
  } catch (error) {
    console.error('Rate lookup error:', error);
    res.status(500).json({ error: 'Failed to fetch rates', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
