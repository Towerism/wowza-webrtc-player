import { EventEmitter } from 'events';

import {
  TPlayerOptions,
  TVideoConfigs,
  TAudioConfigs,
  TStreamItem,
} from '../typings/wowza-types';

import { getUserMedia } from './webrtc/getUserMedia';
import { PeerConnection } from './webrtc/PeerConnection';
import { Wowza } from './wowza/wowza';
import { SDPEnhancer } from './webrtc/SDPEnhancer';

function mungeSDPPlay(sdpStr): string {
  // For greatest playback compatibility,
  // force H.264 playback to constrained baseline (42e01f).

  const sdpLines = sdpStr.split(/\r\n/);
  let sdpStrRet = '';

  for (const sdpIndex in sdpLines) {
    let sdpLine = sdpLines[sdpIndex];

    if (sdpLine.length == 0) continue;

    if (sdpLine.includes('profile-level-id')) {
      // The profile-level-id string has three parts: XXYYZZ, where
      //   XX: 42 baseline, 4D main, 64 high
      //   YY: constraint
      //   ZZ: level ID
      // Look for codecs higher than baseline and force downward.
      const profileLevelId = sdpLine.substr(
        sdpLine.indexOf('profile-level-id') + 17,
        6
      );
      let profile = Number('0x' + profileLevelId.substr(0, 2));
      let constraint = Number('0x' + profileLevelId.substr(2, 2));
      let level = Number('0x' + profileLevelId.substr(4, 2));
      if (profile > 0x42) {
        profile = 0x42;
        constraint = 0xe0;
        level = 0x1f;
      }
      if (constraint == 0x00) {
        constraint = 0xe0;
      }
      const newProfileLevelId =
        ('00' + profile.toString(16)).slice(-2).toLowerCase() +
        ('00' + constraint.toString(16)).slice(-2).toLowerCase() +
        ('00' + level.toString(16)).slice(-2).toLowerCase();

      sdpLine = sdpLine.replace(profileLevelId, newProfileLevelId);
    }

    sdpStrRet += sdpLine;
    sdpStrRet += '\r\n';
  }

  return sdpStrRet;
}

export class WowzaWebRTCPlayer extends EventEmitter {
  public sdpUrl = '';
  public applicationName = '';
  public streamName = '';
  public userData: object | null = null;
  public sdpHandler: TPlayerOptions['sdpHandler'];

  public constraints: MediaStreamConstraints = {
    audio: true,
    video: true,
  };

  public videoConfigs: TVideoConfigs = {
    bitRate: 360,
    codec: '42e01f', // H264 - VP9
    frameRate: 29.97,
  };

  public audioConfigs: TAudioConfigs = {
    codec: 'opus',
    bitRate: 64,
  };

  public iceServers: RTCIceServer[] = [];

  private mediaStream: MediaStream | null = null;
  private pc: PeerConnection | null = null;

  constructor(private video: HTMLVideoElement, options?: TPlayerOptions) {
    super();

    if (options) {
      this.setConfigurations(options);
    }
  }

  private setConfigurations(options: TPlayerOptions): void {
    if (options.constraints) {
      this.constraints = options.constraints;
    }

    if (options.videoConfigs) {
      this.videoConfigs = options.videoConfigs;
    }

    if (options.audioConfigs) {
      this.audioConfigs = options.audioConfigs;
    }

    if (options.applicationName) {
      this.applicationName = options.applicationName;
    }

    if (options.streamName) {
      this.streamName = options.streamName;
    }

    if (options.sdpUrl) {
      this.sdpUrl = options.sdpUrl;
    }

    if (typeof options.userData !== 'undefined') {
      this.userData = options.userData;
    }

    if (options.iceServers) {
      this.iceServers = options.iceServers;
    }

    if (options.sdpHandler) {
      this.sdpHandler = options.sdpHandler;
    }
  }

  public stop(): void {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  public getPeerConnection(): RTCPeerConnection | null {
    return this.pc ? this.pc.getPeerConnection() : null;
  }

  public async playLocal(
    constraints?: MediaStreamConstraints
  ): Promise<MediaStream> {
    if (constraints) {
      this.constraints = constraints;
    }

    const mediaStream = await getUserMedia(this.constraints);
    this.attachStream(mediaStream);

    return mediaStream;
  }

  public stopLocal(): void {
    this.stop();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        track.stop();
      });

      this.mediaStream = null;
    }
  }

  public async playRemote(options?: TPlayerOptions): Promise<void> {
    if (options) {
      this.setConfigurations(options);
    }

    const wowza = this.createWowzaInstance();

    try {
      const { sdp: sdpData } = await wowza.getOffer();
      const pc = this.createPeerConnection();

      pc.on('addstream', this.attachStream.bind(this));
      sdpData.sdp = mungeSDPPlay(sdpData.sdp);
      await pc.setRemoteDescription(sdpData);

      const description = await pc.createAnswer();

      await pc.setLocalDescription(description);

      const { iceCandidates } = await wowza.sendResponse(description);
      iceCandidates.forEach((ice) => {
        pc.attachIceCandidate(ice);
      });
    } finally {
      wowza.disconnect();
    }
  }

  public async publish(options?: TPlayerOptions): Promise<void> {
    if (options) {
      this.setConfigurations(options);
    }

    const wowza = this.createWowzaInstance();

    try {
      const mediaStream = this.mediaStream || (await this.playLocal());
      const pc = this.createPeerConnection();

      pc.attachMediaStream(mediaStream);

      const enhancer = new SDPEnhancer(this.videoConfigs, this.audioConfigs);
      const description = await pc.createOffer();
      const upgradedDescription = this.sdpHandler
        ? this.sdpHandler(description, (sdp) => enhancer.transform(sdp))
        : enhancer.transform(description);

      await pc.setLocalDescription(upgradedDescription);
      const { sdp, iceCandidates } = await wowza.sendOffer(upgradedDescription);

      await pc.setRemoteDescription(sdp);
      iceCandidates.forEach((ice) => {
        pc.attachIceCandidate(ice);
      });
    } finally {
      wowza.disconnect();
    }
  }

  public async getAvailableStreams(): Promise<TStreamItem[]> {
    const wowza = this.createWowzaInstance();

    try {
      const { availableStreams } = await wowza.getAvailableStreams();
      return availableStreams || [];
    } catch (e) {
      return [];
    } finally {
      wowza.disconnect();
    }
  }

  private createWowzaInstance(): Wowza {
    const wowza = new Wowza(
      this.sdpUrl,
      {
        applicationName: this.applicationName,
        sessionId: '[empty]',
        streamName: this.streamName,
      },
      this.userData
    );

    return wowza;
  }

  private createPeerConnection(): PeerConnection {
    this.pc = new PeerConnection(this.iceServers);

    return this.pc;
  }

  private attachStream(stream: MediaStream): void {
    this.mediaStream = stream;

    try {
      const oldStream =
        this.video.srcObject instanceof MediaStream && this.video.srcObject;
      if (!oldStream || oldStream.id !== stream.id) {
        this.video.srcObject = stream;
      }
    } catch (error) {
      this.video.src = window.URL.createObjectURL(stream);
    }

    this.video.play();
  }
}
