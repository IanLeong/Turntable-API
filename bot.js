/**
 * Copyright 2011,2012 Alain Gilbert <alain.gilbert.15@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

var WebSocket   = require('./websocket').WebSocket
  , events      = require('events').EventEmitter
  , crypto      = require('crypto')
  , http        = require('http')
  , net         = require('net')
  , querystring = require('querystring');

var Bot = function () {
   var self           = this;
   this.auth          = arguments[0];
   this.userId        = arguments[1];
   if (arguments.length == 3) {
      this.roomId     = arguments[2];
   } else {
      this.roomId     = null;
   }
   this.debug         = false;
   this.callback      = null;
   this.currentSongId = null;
   this.lastHeartbeat = new Date();
   this.lastActivity  = new Date();
   this.clientId      = new Date().getTime() + '-0.59633534294921572';
   this._msgId        = 0;
   this._cmds         = [];
   this._isConnected  = false;
   this.CHATSERVER_ADDRS = [["chat2.turntable.fm", 80], ["chat3.turntable.fm", 80]];

   var infos = this.getHashedAddr(this.roomId ? this.roomId : Math.random().toString());
   var url = 'ws://'+infos[0]+':'+infos[1]+'/socket.io/websocket';

   this.ws = new WebSocket(url);
   this.ws.onmessage = function (msg) { self.onMessage(msg); };
   if (this.roomId) {
      // TODO: Should not be here... see the other todo (in roomRegister)
      this.callback = function () {
         var rq = { api: 'room.register', roomid: self.roomId };
         self._send(rq, null);
      };
   }
};

Bot.prototype.__proto__ = events.prototype;


Bot.prototype.listen = function (port, address) {
   var self = this;
   http.createServer(function (req, res) {
      var dataStr = '';
      req.on('data', function (chunk) {
         dataStr += chunk.toString();
      });
      req.on('end', function () {
         var data = querystring.parse(dataStr);
         req._POST = data;
         self.emit('httpRequest', req, res);
      });
   }).listen(port, address);
};


Bot.prototype.tcpListen = function (port, address) {
   var self = this;
   net.createServer(function (socket) {
      socket.on('connect', function () {
         self.emit('tcpConnect', socket);
      });
      socket.on('data', function (data) {
         var msg = data.toString();
         if (msg[msg.length - 1] == '\n') {
            self.emit('tcpMessage', socket, msg.substr(0, msg.length-1));
         }
      });
      socket.on('end', function () {
         self.emit('tcpEnd', socket);
      });
   }).listen(port, address);
};


Bot.prototype.onMessage = function (msg) {
   var self = this;
   var data = msg.data;

   var heartbeat_rgx = /~m~[0-9]+~m~(~h~[0-9]+)/;
   if (data.match(heartbeat_rgx)) {
      self._heartbeat(data.match(heartbeat_rgx)[1]);
      self.lastHeartbeat = new Date();
      self.roomNow(); // TODO: see if it's really usefull
      return;
   }

   if (this.debug) { console.log('> '+data); }

   if (msg.data == '~m~10~m~no_session') {
      self.userAuthenticate(function () {
         if (!self._isConnected) {
            self.emit('ready');
         }
         self.callback();
         self._isConnected = true;
      });
      return;
   }

   this.lastActivity = new Date();

   var len_rgx = /~m~([0-9]+)~m~/;
   var len = data.match(len_rgx)[1];
   var json = JSON.parse(data.substr(data.indexOf('{'), len));
   for (var i=0; i<self._cmds.length; i++) {
      var id  = self._cmds[i][0];
      var rq  = self._cmds[i][1];
      var clb = self._cmds[i][2];
      if (id == json.msgid) {
         switch (rq.api) {
            case 'room.info':
               if (json.success === true) {
                  var currentSong = json.room.metadata.current_song;
                  if (currentSong) {
                     self.currentSongId = currentSong._id;
                  }
               }
               break;
            case 'room.register':
               if (json.success === true) {
                  self.roomId = rq.roomid;
                  self.roomInfo(function (data) {
                     self.emit('roomChanged', data);
                  });
                  clb = null;
               }
               break;
            case 'room.deregister':
               if (json.success === true) {
                  self.roomId = null;
               }
               break;
         }

         if (clb) {
            clb(json);
         }

         self._cmds.splice(i, 1);
         break;
      }
   }

   switch(json['command']) {
      case 'registered':
         self.emit('registered', json);
         break;
      case 'deregistered':
         self.emit('deregistered', json);
         break;
      case 'speak':
         self.emit('speak', json);
         break;
      case 'nosong':
         self.emit('nosong', json);
         break;
      case 'newsong':
         self.currentSongId = json.room.metadata.current_song._id;
         self.emit('newsong', json);
         break;
      case 'update_votes':
         self.emit('update_votes', json);
         break;
      case 'booted_user':
         self.emit('booted_user', json);
         break;
      case 'update_user':
         self.emit('update_user', json);
         break;
      case 'add_dj':
         self.emit('add_dj', json);
         break;
      case 'rem_dj':
         self.emit('rem_dj', json);
         break;
      case 'new_moderator':
         self.emit('new_moderator', json);
         break;
      case 'rem_moderator':
         self.emit('rem_moderator', json);
         break;
      default:
         if (json['command']) {
            //console.log('Command: ', json);
         } else if (typeof(json['msgid']) == 'number') {
            if (!json['success']) {
               //console.log(json);
            }
         }
   }
};

Bot.prototype._heartbeat = function (msg) {
   this.ws.send('~m~'+msg.length+'~m~'+msg);
   this._msgId++;
};

Bot.prototype.toString = function () {
   return '';
};

Bot.prototype._send = function (rq, callback) {
   rq.msgid    = this._msgId;
   rq.clientid = this.clientId;
   rq.userid   = this.userId;
   rq.userauth = this.auth;

   var msg = JSON.stringify(rq);

   if (this.debug) { console.log('< '+msg); }
   this.ws.send('~m~'+msg.length+'~m~'+msg);
   this._cmds.push([this._msgId, rq, callback]);
   this._msgId++;
}

Bot.prototype.hashMod = function (a, b) {
   var d = crypto.createHash("sha1").update(a).digest('hex');
   var c = 0;
   for (var i=0; i<d.length; i++) {
      c += d.charCodeAt(i);
   }
   return c % b;
};

Bot.prototype.getHashedAddr = function (a) {
   return this.CHATSERVER_ADDRS[this.hashMod(a, this.CHATSERVER_ADDRS.length)];
},

Bot.prototype.close = function () {
   this.ws.close();
};

Bot.prototype.roomNow = function (callback) {
   var rq = { api: 'room.now' };
   this._send(rq, callback);
};

Bot.prototype.listRooms = function (skip, callback) {
   skip = skip !== undefined ? skip : 0;
   var rq = { api: 'room.list_rooms', skip: skip };
   this._send(rq, callback);
};

Bot.prototype.roomRegister = function (roomId, callback) {
   var self = this;
   var infos = this.getHashedAddr(roomId);
   var url = 'ws://'+infos[0]+':'+infos[1]+'/socket.io/websocket';
   this.ws.close();
   this.callback = function () {
      var rq = { api: 'room.register', roomid: roomId };
      self._send(rq, callback);
   };
   // TODO: This should not be here at all...
   this.ws = new WebSocket(url);
   this.ws.onmessage = function (msg) { self.onMessage(msg); };
};

Bot.prototype.roomDeregister = function (callback) {
   var rq = { api: 'room.deregister', roomid: this.roomId };
   this._send(rq, callback);
};

Bot.prototype.roomInfo = function (callback) {
   var rq = { api: 'room.info', roomid: this.roomId };
   this._send(rq, callback);
};

Bot.prototype.speak = function (msg, callback) {
   var rq = { api: 'room.speak', roomid: this.roomId, text: msg };
   this._send(rq, callback);
};

Bot.prototype.bootUser = function (userId, reason, callback) {
   var rq = { api: 'room.boot_user', roomid: this.roomId, target_userid: userId, reason: reason };
   this._send(rq, callback);
};


Bot.prototype.addModerator = function (userId, callback) {
   var rq = { api: 'room.add_moderator', roomid: this.roomId, target_userid: userId };
   this._send(rq, callback);
};

Bot.prototype.remModerator = function (userId, callback) {
   var rq = { api: 'room.rem_moderator', roomid: this.roomId, target_userid: userId };
   this._send(rq, callback);
};

Bot.prototype.addDj = function (callback) {
   var rq = { api: 'room.add_dj', roomid: this.roomId };
   this._send(rq, callback);
};

Bot.prototype.remDj = function () {
   if (arguments.length == 1) {
      if (typeof arguments[0] === 'function') {
         var djId     = null;
         var callback = arguments[0];
      } else if (typeof arguments[0] === 'string') {
         var djId     = arguments[0];
         var callback = null;
      }
   } else if (arguments.length == 2) {
      var djId     = arguments[0];
      var callback = arguments[1];
   }
   var rq = { api: 'room.rem_dj', roomid: this.roomId };
   if (djId) { rq.djid = djId; }
   this._send(rq, callback);
};

Bot.prototype.stopSong = function (callback) {
   var rq = { api: 'room.stop_song', roomid: this.roomId };
   this._send(rq, callback);
};

Bot.prototype.vote = function (val, callback) {
   var vh = crypto.createHash("sha1").update(this.roomId + val + this.currentSongId).digest('hex');
   var th = crypto.createHash("sha1").update(Math.random().toString()).digest('hex');
   var ph = crypto.createHash("sha1").update(Math.random().toString()).digest('hex');
   var rq = { api: 'room.vote', roomid: this.roomId, val: val, vh: vh, th: th, ph: ph };
   this._send(rq, callback);
};

Bot.prototype.userAuthenticate = function (callback) {
   var rq = { api: 'user.authenticate' };
   this._send(rq, callback);
};

Bot.prototype.userInfo = function (callback) {
   var rq = { api: 'user.info' };
   this._send(rq, callback);
};

Bot.prototype.modifyLaptop = function (laptop, callback) {
   var rq = { api: 'user.modify', laptop: laptop };
   this._send(rq, callback);
};

Bot.prototype.modifyName = function (name, callback) {
   var rq = { api: 'user.modify', name: name };
   this._send(rq, callback);
};

Bot.prototype.setAvatar = function (avatarId, callback) {
   var rq = { api: 'user.set_avatar', avatarid: avatarId };
   this._send(rq, callback);
};

Bot.prototype.playlistAll = function (playlistName, callback) {
   if (!playlistName) { playlistName = 'default'; }
   var rq = { api: 'playlist.all', playlist_name: playlistName };
   this._send(rq, callback);
};

Bot.prototype.playlistAdd = function (playlistName, songId, callback) {
   if (!playlistName) { playlistName = 'default'; }
   var rq = { api: 'playlist.add', playlist_name: playlistName, song_dict: { fileid: songId }, index: 0 };
   this._send(rq, callback);
};

Bot.prototype.playlistRemove = function (playlistName, index, callback) {
   if (!playlistName) { playlistName = 'default'; }
   var rq = { api: 'playlist.remove', playlist_name: playlistName, index: index };
   this._send(rq, callback);
};

exports.Bot = Bot;
