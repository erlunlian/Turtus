// TODO: This should serve as a core module for any js based tutus client
// but I still need to remove some specific dependencies

import SimplePeer from 'simple-peer'
import EventEmitter from 'eventemitter3'
import ServerController from './ServerController'

export const EVENT_TYPES = {
  STREAM : {
    REQUEST : 'stream/request',
    READY : 'stream/ready'
  },
  IDENTITY : {
    PROVIDE : 'identity/provide',
    REQUEST : 'identity/request',
    RESPONSE : 'identity/response'
  },
  ANNOUNCE : 'announce',
  SIGNAL : 'signal',
  PEER_CONNECT : 'peer/connect',
  PEER_DISCONNECT : 'peer/disconnect'
}

export default class WRTCSessionManager extends EventEmitter {
  constructor(options = {}){
    super()
    const { 
      server,
      signalServer = server
    } = options
    this.id = null // set by signal server
    this.clientType = 'client'
    this.signalServer = signalServer
    this.ws = null // set in init function
    /** @type {Map<string, SimplePeer.Instance>} */
    this.peers = new Map()
    this._complete = null // set in init
  }

  /**
   * Establiashes the Websocket connection to our 
   * server and attaches events.
   * @returns {Promise<void>}
   */
  init(){
    if(this.ws){
      return Promise.reject('init already called')
    }
    return new Promise(async (res, rej)=>{
      // ping server 
      await ServerController.ping()
      // establish websocket connection
      this.ws = new WebSocket(this.signalServer)
      // setup event listeners
      this.ws.addEventListener(   'open', (e) => this._onServerConnection(e))
      this.ws.addEventListener(  'close', (e) => this._onServerClose(e))
      this.ws.addEventListener(  'error', (err) => this._onServerError(err))
      this.ws.addEventListener('message', (msg) => this._onServerMessage(msg))

      // Set promise resolver
      this._complete = err => err ? rej(err) : res()
    })
  }

  /**
   * Called when a message is received from the ws connection
   * @param {*} message 
   * @param  {...any} args 
   */
  _onServerMessage(message){
    const data = JSON.parse(message.data)
    // console.log(data, ...args)
    const { type, ...rest } = data
    console.log('[Server]', type, rest)
    switch (type) {
      case EVENT_TYPES.IDENTITY.PROVIDE:
        this._setIdentity(rest)
        break
      case EVENT_TYPES.ANNOUNCE:
        this._announce(rest, true)
        break
      case EVENT_TYPES.SIGNAL:
        this._signal(rest)
        break
      default:
        console.warn(`[WS] no handler for event: ${type}`)
        break
    }
  }

  _onServerConnection(){
    console.log('Connected To Server')
  }

  _onServerClose(err){
    console.log('Disconnected From Server')
    // this._complete(err)
  }

  _onServerError(err){
    console.log(err)
  }

  _onPeerSignal(peer, signal){
    this.ws.send(JSON.stringify({
      type: 'signal',
      target: peer.id,
      signal
    }))
  }

  /**
   * 
   * @param {SimplePeer.Instance} peer 
   */
  _onPeerConnection(peer){
    this.emit(EVENT_TYPES.PEER_CONNECT, peer)
    // request peer's identity
    const packet = this.package(EVENT_TYPES.IDENTITY.REQUEST)
    peer.send(packet)
  }

  _onPeerData(peer, chunk){
    const {type, ...data} = JSON.parse(chunk)
    console.log(type, data)
    if(!this[type]){
      console.warn(`[Wrtc] no handler for event: ${type}`)
      // console.log(JSON.parse(chunk))
      this.emit(EVENT_TYPES.PEER_MESSAGE, peer, {type, ...data})
      return 
    }
    this[type](peer, data)
  }

  _onPeerClose(peer){
    this.emit(EVENT_TYPES.PEER_DISCONNECT, peer.id)
    this.peers.delete(peer.id)
  }

  _onPeerError(peer, error){
    console.log(peer.id, error)
  }

  _onPeerStream(peer, stream){
    // TODO: Identify the stream type 
    console.log(stream, peer)
    this.emit('browser.stream', peer, stream)
  }

  /**
   * Announce peer
   * @param {*} msg 
   * @param {*} initiator 
   */
  _announce(msg, initiator=true) {
    const peer = new SimplePeer({ initiator })
    peer.id = msg.id || msg.cid
    console.log('Peer Announced(?)', peer.id)
    this.peers.set(peer.id, peer)

    // Set events
    this._addPeerListeners(peer)

    return this;
  }

  /**
   * Add listeners to peer
   * @param {SimplePeer.Instance} peer 
   */
  _addPeerListeners(peer){
    peer.on('connect', () => this._onPeerConnection(peer))
    peer.on(  'error', (err) => this._onPeerError(peer, err))
    peer.on( 'signal', (signal) => this._onPeerSignal(peer, signal))
    peer.on(  'close', () => this._onPeerClose(peer))
    peer.on(   'data', (data) => this._onPeerData(peer, data))
    peer.on( 'stream', (stream) => this._onPeerStream(peer, stream))
  }

  /**
   * set identity and resolve initialization
   * @param {*} data 
   */
  _setIdentity(data){
    const { id } = data
    this.id = id
    this._complete && this._complete()
  }

  /**
   * Signal Event from Server
   * Send to specified peer
   * @param {*} data 
   */
  _signal(data){
    console.log('🤔 signal received')
    const id = data.id || data.cid || data.sender
    if(!this.peers.has(id)){
      this._announce(data, false)
    }
    this.peers.get(id).signal(data.signal)
  }

  [EVENT_TYPES.STREAM.READY](peer, data){
    // Request the stream when it's ready
    this.emit(EVENT_TYPES.STREAM.READY)
    peer.send(this.package(EVENT_TYPES.STREAM.REQUEST))
  }

  [EVENT_TYPES.IDENTITY.REQUEST](peer, data){
    console.log('Identity Request Recieved From', peer.id)
    console.log(data)
    const pData = {
      clientType : this.clientType
    }
    const packet = this.package(EVENT_TYPES.IDENTITY.RESPONSE, pData)
    peer.send(packet)
  }

  /**
   * Attaches a stream to a peer when requested
   * @param {*} msg 
   */
  [EVENT_TYPES.STREAM.REQUEST](peer){
    // const { sender } = msg
    // const peer = this.peers.get(sender)
    this.emit(EVENT_TYPES.STREAM.REQUEST, peer)
  }

  [EVENT_TYPES.IDENTITY.RESPONSE](peer, data){
    console.log('Identity Response Received From', peer.id)
    console.log(data)
  }

  package(event, data={}){
    return JSON.stringify({
      type : event,
      sender : this.id,
      ...data
    })
  }

  /**
   * Send a message to all connected peers
   * @param {*} msg 
   */
  broadcast(msg){
    for(let [, peer] of this.peers){
      peer.send(msg)
    }
  }

  destroy(){
    return this
  }
}