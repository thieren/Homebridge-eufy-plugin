/* eslint-disable @typescript-eslint/no-var-requires */
import { EufySecurity, EufySecurityConfig, Device, Station } from 'eufy-security-client';
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import fs from 'fs';
import bunyan from 'bunyan';

import { Accessory } from './configui/app/accessory';
import { LoginResult, LoginFailReason } from './configui/app/util/types';

class UiServer extends HomebridgePluginUiServer {
  storagePath: string;
  storedAccessories_file: string;
  accessories: Accessory[] = [];

  config: EufySecurityConfig;
  eufyClient: EufySecurity | null;

  private log: bunyan;

  constructor() {
    super();

    this.storagePath = this.homebridgeStoragePath + '/eufysecurity';
    this.storedAccessories_file = this.storagePath + '/accessories.json';

    this.eufyClient = null;

    const plugin = require('../../package.json');

    this.log = bunyan.createLogger({
      name: '[EufySecurity-' + plugin.version + ']',
      hostname: '',
      streams: [{
        level: 'debug',
        type: 'rotating-file',
        path: this.storagePath + '/configui-server.log',
        period: '1d',
        count: 3,
      }],
    });

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath);
    }

    this.config = {
      username: '',
      password: '',
      language: 'en',
      persistentDir: this.storagePath,
      p2pConnectionSetup: 0,
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
      acceptInvitations: true,
    };

    this.onRequest('/login', this.login.bind(this));
    this.onRequest('/storedAccessories', this.loadStoredAccessories.bind(this));
    this.onRequest('/reset', this.resetPlugin.bind(this));

    this.ready();
  }

  async login(options): Promise<LoginResult> {

    if (!this.eufyClient && options && options.username && options.password && options.country) {
      this.accessories = []; // clear accessories array so that it can be filled with all devices after login
      this.log.debug('init eufyClient');
      this.config.username = options.username;
      this.config.password = options.password;
      this.config.country = options.country;
      try {
        this.eufyClient = await EufySecurity.initialize(this.config, this.log);
      } catch (err) {
        this.log.error(err);
      }
      this.eufyClient?.on('station added', this.addStation.bind(this));
      this.eufyClient?.on('device added', this.addDevice.bind(this));
    }

    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        resolve({
          success: false,
          failReason: LoginFailReason.TIMEOUT,
        });
      }, 25000);

      if (options && options.username && options.password && options.country) {
        // login with credentials
        this.log.debug('login with credentials');
        try {
          this.loginHandlers(resolve);
          this.eufyClient?.connect()
            .then(() => {
              this.log.debug('connected?: ' + this.eufyClient?.isConnected());
            })
            .catch((err) => this.log.error(err));
        } catch (err) {
          this.log.error(err);
          resolve({
            success: false,
            failReason: LoginFailReason.UNKNOWN,
            data: {
              error: err,
            },
          });
        }
      } else if (options && options.verifyCode) {
        // login with tfa code
        try {
          this.loginHandlers(resolve);
          this.eufyClient?.connect({
            verifyCode: options.verifyCode,
            force: false,
          });
        } catch (err) {
          resolve({
            success: false,
            failReason: LoginFailReason.UNKNOWN,
            data: {
              error: err,
            },
          });
        }
      } else if (options && options.captcha) {
        // login witch captcha
        try {
          this.loginHandlers(resolve);
          this.eufyClient?.connect({
            captcha: {
              captchaCode: options.captcha.captchaCode,
              captchaId: options.captcha.captchaId,
            },
            force: false,
          });
        } catch (err) {
          resolve({
            success: false,
            failReason: LoginFailReason.UNKNOWN,
            data: {
              error: err,
            },
          });
        }
      } else {
        reject('unsupported login method');
      }
    });
  }

  async loadStoredAccessories(): Promise<Accessory[]> {
    try {
      const accessories = JSON.parse(fs.readFileSync(this.storedAccessories_file, { encoding: 'utf-8' }));
      return Promise.resolve(accessories as Accessory[]);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  loginHandlers(resolveCallback) {
    this.eufyClient?.once('tfa request', () => {
      this.log.debug('tfa request event');
      resolveCallback({
        success: false,
        failReason: LoginFailReason.TFA, // TFA
      });
    });

    this.eufyClient?.once('captcha request', (id, captcha) => {
      this.log.debug('captcha request event');
      resolveCallback({
        success: false,
        failReason: LoginFailReason.CAPTCHA, // Captcha
        data: {
          id: id,
          captcha: captcha,
        },
      });
    });

    this.eufyClient?.once('connect', () => {
      this.log.debug('connect event');
      resolveCallback({
        success: true,
      });
    });
  }

  addStation(station: Station) {
    const s: Accessory = {
      uniqueId: station.getSerial(),
      displayName: station.getName(),
      station: true,
      type: station.getDeviceType(),
    };
    this.accessories.push(s);
    this.storeAccessories();
    this.pushEvent('addAccessory', s);
  }

  addDevice(device: Device) {
    const d: Accessory = {
      uniqueId: device.getSerial(),
      displayName: device.getName(),
      station: false,
      type: device.getDeviceType(),
    };
    this.accessories.push(d);
    this.storeAccessories();
    this.pushEvent('addAccessory', d);
  }

  storeAccessories() {
    fs.writeFileSync(this.storedAccessories_file, JSON.stringify(this.accessories));
  }

  async resetPlugin() {
    try {
      fs.rmSync(this.storagePath, { recursive: true });
      return { result: 1 }; //file removed
    } catch (err) {
      return { result: 0 }; //error while removing the file
    }
  }
}

// start the instance of the server
(() => {
  return new UiServer();
})();
