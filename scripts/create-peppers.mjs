import {randomBytes} from 'node:crypto';
console.log('Use separate values; copy privately and never commit them.');
console.log('PIN_PEPPER=' + randomBytes(32).toString('hex'));
console.log('OTP_PEPPER=' + randomBytes(32).toString('hex'));
