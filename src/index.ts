import { Buffer } from 'node:buffer';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:stream';
import { clearInterval } from 'node:timers';

import { createBufferFrom, Z21RecordToBuffer, Z21XBusRecordToArray } from './converters';
import {
  ErrorResponseParser,
  HWInfoResponse,
  HWInfoResponseParser,
  LocoResponse,
  LocoResponseParser,
  SerialNumberResponse,
  SerialNumberResponseParser,
  StatusResponse,
  StatusResponseParser,
  Z21_HEADER
} from './packets';

const DEFAULT_IP = '192.168.0.111';
const PORT = 21_105;
const IDLE_TIMER_SEC = 10;
const IDLE_MAX_SEC = 60 - 5 - IDLE_TIMER_SEC;
const TIMEOUT_MS = 1000;

type ResolverFunction = (receivedData: Buffer) => boolean;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface Z21Client {
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'debug', listener: (event: string, debugData: object) => void): this;
  on(event: 'locoInfo', listener: (locoInfo: LocoResponse) => void): this;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, unicorn/prefer-event-target
export class Z21Client extends EventEmitter {
  private ip: string;
  private updClient = createSocket('udp4');
  private lastSendAt = 0;
  private idleTimer = 0;
  private locoInfos: Map<number, LocoResponse> = new Map<number, LocoResponse>();

  constructor(ip = DEFAULT_IP) {
    super();

    this.ip = ip;

    this.updClient.on('error', (error: Error) => this.emit('error', error));
    this.updClient.on('message', (receivedData: Buffer): boolean => {
      if (receivedData.length < 0) {
        this.emit('error', new Error('Empty received data'));
        return false;
      }

      while (receivedData.length > 0) {
        const length = receivedData.readInt8(0);
        if (receivedData.length < length) {
          this.emit('error', new Error(`Too short received data: ${receivedData.length} < ${length}`));
          return false;
        }
        this.processReceivedData(createBufferFrom(receivedData, 0, length));
        receivedData = createBufferFrom(receivedData, length);
      }

      return true;
    });
  }

  public close() {
    clearInterval(this.idleTimer);
    this.logOff();
    this.updClient.close();
  }

  private send(buf: Buffer) {
    this.emit('debug', 'send', buf);
    this.updClient.send(buf, PORT, this.ip, (error) => {
      if (error) this.emit('error', error);
      this.lastSendAt = Date.now();
    });
  }

  private resolvers: Map<string, ResolverFunction> = new Map<string, ResolverFunction>();
  private processReceivedData(receivedData: Buffer): boolean {
    this.emit('debug', 'received', receivedData);

    if (receivedData.length < 4) {
      this.emit('error', new Error(`Too short received data: ${receivedData.length}`));
      return false;
    }

    if (ErrorResponseParser(receivedData)) return this.emit('error', new Error('Invalid command'));

    for (const [code, resolverFunction] of this.resolvers.entries())
      if (resolverFunction(receivedData)) {
        this.resolvers.delete(code);
        break;
      }

    const locoInfo = LocoResponseParser(receivedData);
    if (
      locoInfo &&
      (!this.locoInfos.has(locoInfo.address) ||
        JSON.stringify(this.locoInfos.get(locoInfo.address)) !== JSON.stringify(locoInfo))
    ) {
      this.locoInfos.set(locoInfo.address, locoInfo);
      this.emit('locoInfo', locoInfo);
    }

    return true;
  }

  public async getSerialNumber(): Promise<SerialNumberResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(reject, TIMEOUT_MS, new Error('getSerialNumber timeout'));
      this.resolvers.set('getSerialNumber', (receivedData) => {
        const result = SerialNumberResponseParser(receivedData);
        if (result) {
          resolve(result);
          clearTimeout(timer);
          return true;
        }
        return false;
      });
      this.send(Z21RecordToBuffer(Z21_HEADER.LAN_GET_SERIAL_NUMBER));
    });
  }
  public async getHWInfo(): Promise<HWInfoResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(reject, TIMEOUT_MS, new Error('getHWInfo timeout'));
      this.resolvers.set('getHWInfo', (receivedData) => {
        const result = HWInfoResponseParser(receivedData);
        if (result) {
          resolve(result);
          clearTimeout(timer);
          return true;
        }
        return false;
      });
      this.send(Z21RecordToBuffer(Z21_HEADER.LAN_GET_HWINFO));
    });
  }
  public logOff() {
    this.send(Z21RecordToBuffer(Z21_HEADER.LAN_LOGOFF));
  }
  public setBroadcastFlag(enable: boolean) {
    this.send(Z21RecordToBuffer(Z21_HEADER.LAN_SET_BROADCASTFLAGS, enable ? 1 : 0, 0, 0, 0));
    if (enable)
      this.idleTimer = setInterval(() => {
        if (Date.now() - this.lastSendAt > IDLE_MAX_SEC * 1000) void this.getStatus();
      }, IDLE_TIMER_SEC * 1000) as unknown as number;
    else clearInterval(this.idleTimer);
  }

  public async getStatus(): Promise<StatusResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(reject, TIMEOUT_MS, new Error('getStatus timeout'));
      this.resolvers.set('getStatus', (receivedData) => {
        const result = StatusResponseParser(receivedData);
        if (result) {
          resolve(result);
          clearTimeout(timer);
          return true;
        }
        return false;
      });
      this.send(
        Z21RecordToBuffer(
          Z21_HEADER.LAN_X_GET_STATUS.header,
          ...Z21XBusRecordToArray(Z21_HEADER.LAN_X_GET_STATUS.xHeader, Z21_HEADER.LAN_X_GET_STATUS.db0)
        )
      );
    });
  }

  public trackPowerOff() {
    this.send(
      Z21RecordToBuffer(
        Z21_HEADER.LAN_X_SET_TRACK_POWER_OFF.header,
        ...Z21XBusRecordToArray(Z21_HEADER.LAN_X_SET_TRACK_POWER_OFF.xHeader, Z21_HEADER.LAN_X_SET_TRACK_POWER_OFF.db0)
      )
    );
  }
  public trackPowerOn() {
    this.send(
      Z21RecordToBuffer(
        Z21_HEADER.LAN_X_SET_TRACK_POWER_ON.header,
        ...Z21XBusRecordToArray(Z21_HEADER.LAN_X_SET_TRACK_POWER_ON.xHeader, Z21_HEADER.LAN_X_SET_TRACK_POWER_ON.db0)
      )
    );
  }
  public trackStop() {
    this.send(
      Z21RecordToBuffer(Z21_HEADER.LAN_X_SET_STOP.header, ...Z21XBusRecordToArray(Z21_HEADER.LAN_X_SET_STOP.xHeader))
    );
  }

  public subscribeLocoInfo(locoAddress: number): void {
    locoAddress &= 0x3f_ff;
    const ADDR_MSB = Math.floor(locoAddress / 256) | (locoAddress > 128 ? 0xc0 : 0x0);
    const ADDR_LSB = locoAddress % 256;
    this.send(
      Z21RecordToBuffer(
        Z21_HEADER.LAN_X_GET_LOCO_INFO.header,
        ...Z21XBusRecordToArray(
          Z21_HEADER.LAN_X_GET_LOCO_INFO.xHeader,
          Z21_HEADER.LAN_X_GET_LOCO_INFO.dbo,
          ADDR_MSB,
          ADDR_LSB
        )
      )
    );
  }

  public async getLocoInfo(locoAddress: number): Promise<LocoResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(reject, TIMEOUT_MS, new Error('getLocoInfo timeout'));
      this.resolvers.set(`getLocoInfo|${locoAddress}`, (receivedData) => {
        const result = LocoResponseParser(receivedData, locoAddress);
        if (result) {
          resolve(result);
          clearTimeout(timer);
          return true;
        }
        return false;
      });
      this.subscribeLocoInfo(locoAddress);
    });
  }

  public driveLoco(locoAddress: number, direction: boolean, speed: number, speedSteps = 128): boolean {
    locoAddress &= 0x3f_ff;
    const ADDR_MSB = Math.floor(locoAddress / 256) | (locoAddress > 128 ? 0xc0 : 0x0);
    const ADDR_LSB = locoAddress % 256;

    if (speed < 0) {
      speed = -1 * speed;
      direction = !direction;
    }

    let DB0 = 0;
    switch (speedSteps) {
      case 14:
        if (speed > 14) speed = 14;
        DB0 = 0x10;
        break;
      case 28:
        if (speed > 28) speed = 28;
        DB0 = 0x12;
        break;
      case 128:
        if (speed > 126) speed = 126;
        DB0 = 0x13;
        break;
    }
    if (!DB0) {
      this.emit('error', new Error('Speedstep must be 14, 28 or 128'));
      return false;
    }

    if (speed > 0) speed += 1;

    const DB3 = (direction ? 0x80 : 0x00) + speed;

    this.send(
      Z21RecordToBuffer(
        Z21_HEADER.LAN_X_SET_LOCO_DRIVE.header,
        ...Z21XBusRecordToArray(Z21_HEADER.LAN_X_SET_LOCO_DRIVE.xHeader, DB0, ADDR_MSB, ADDR_LSB, DB3)
      )
    );

    return true;
  }

  private setLocoFunctions(locoAddress: number, function_: number, state: number): void {
    locoAddress &= 0x3f_ff;
    const ADDR_MSB = Math.floor(locoAddress / 256) | (locoAddress > 128 ? 0xc0 : 0x0);
    const ADDR_LSB = locoAddress % 256;

    if (function_ < 0) function_ = 0;
    if (function_ > 20) function_ = 20;

    let DB3 = 0;
    switch (state) {
      case 1:
        DB3 = 0x40;
        break;
      case 0:
        DB3 = 0;
        break;
      case -1: //toggle
        DB3 = 0x80;
        break;
    }
    DB3 += function_;

    this.send(
      Z21RecordToBuffer(
        Z21_HEADER.LAN_X_SET_LOCO_FUNCTION.header,
        ...Z21XBusRecordToArray(
          Z21_HEADER.LAN_X_SET_LOCO_FUNCTION.xHeader,
          Z21_HEADER.LAN_X_SET_LOCO_FUNCTION.dbo,
          ADDR_MSB,
          ADDR_LSB,
          DB3
        )
      )
    );
  }

  public setLocoFunctionsOn(locoAddress: number, function_: number) {
    this.setLocoFunctions(locoAddress, function_, 1);
  }
  public setLocoFunctionsOff(locoAddress: number, function_: number) {
    this.setLocoFunctions(locoAddress, function_, 0);
  }
  public toggleLocoFunctions(locoAddress: number, function_: number) {
    this.setLocoFunctions(locoAddress, function_, -1);
  }
}
