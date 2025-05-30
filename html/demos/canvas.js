// We import the settings.js file to know which address we should contact
// to talk to Janus, and optionally which STUN/TURN servers should be
// used as well. Specifically, that file defines the "server" and
// "iceServers" properties we'll pass when creating the Janus session.

/* global iceServers:readonly, Janus:readonly, server:readonly */

var janus = null;
var echotest = null;
var opaqueId = "canvas-"+Janus.randomString(12);

var remoteTracks = {}, remoteVideos = 0;
var bitrateTimer = null;

var audioenabled = false;
var videoenabled = false;

var acodec = (getQueryStringValue("acodec") !== "" ? getQueryStringValue("acodec") : null);
var vcodec = (getQueryStringValue("vcodec") !== "" ? getQueryStringValue("vcodec") : null);
var vprofile = (getQueryStringValue("vprofile") !== "" ? getQueryStringValue("vprofile") : null);
var simulcastStarted = false;

var stream = null;
var canvasStream = null;

// We'll try to do 15 frames per second: should be relatively fluid, and
// most important should be doable in JavaScript on lower end machines too
var fps = 15;
// Let's add some placeholders for the tweaks we can configure
var myText = "Hi there!";
var myColor = "white";
var myFont = "20pt Calibri";
var myX = 15, myY = 460;
// As the "watermark", we'll use a smaller version of the Janus logo
var logoUrl = "../janus-logo-small.png";
var logoW = 340, logoH = 110;
var logoS = 0.4;
var logoX = 640 - logoW*logoS - 15, logoY = 15;


$(document).ready(function() {
	// Initialize the library (all console debuggers enabled)
	Janus.init({debug: "all", callback: function() {
		// Use a button to start the demo
		$('#start').one('click', function() {
			$(this).attr('disabled', true).unbind('click');
			// Make sure the browser supports WebRTC
			if(!Janus.isWebrtcSupported()) {
				bootbox.alert("No WebRTC support... ");
				return;
			}
			// Create session
			janus = new Janus(
				{
					server: server,
					iceServers: iceServers,
					// Should the Janus API require authentication, you can specify either the API secret or user token here too
					//		token: "mytoken",
					//	or
					//		apisecret: "serversecret",
					success: function() {
						// Attach to EchoTest plugin
						janus.attach(
							{
								plugin: "janus.plugin.echotest",
								opaqueId: opaqueId,
								success: function(pluginHandle) {
									$('#details').remove();
									echotest = pluginHandle;
									Janus.log("Plugin attached! (" + echotest.getPlugin() + ", id=" + echotest.getId() + ")");
									// We're connected to the plugin, create and populate the canvas element
									createCanvas();
									$('#start').removeAttr('disabled').html("Stop")
										.click(function() {
											$(this).attr('disabled', true);
											if(bitrateTimer)
												clearInterval(bitrateTimer);
											bitrateTimer = null;
											janus.destroy();
										});
								},
								error: function(error) {
									console.error("  -- Error attaching plugin...", error);
									bootbox.alert("Error attaching plugin... " + error);
								},
								consentDialog: function(on) {
									Janus.debug("Consent dialog should be " + (on ? "on" : "off") + " now");
									if(on) {
										// Darken screen and show hint
										$.blockUI({
											message: '<div><img src="up_arrow.png"/></div>',
											baseZ: 3001,
											css: {
												border: 'none',
												padding: '15px',
												backgroundColor: 'transparent',
												color: '#aaa',
												top: '10px',
												left: '100px'
											} });
									} else {
										// Restore screen
										$.unblockUI();
									}
								},
								iceState: function(state) {
									Janus.log("ICE state changed to " + state);
								},
								mediaState: function(medium, on, mid) {
									Janus.log("Janus " + (on ? "started" : "stopped") + " receiving our " + medium + " (mid=" + mid + ")");
								},
								webrtcState: function(on) {
									Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
									$("#videoleft").parent().unblock();
								},
								slowLink: function(uplink, lost, mid) {
									Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
										" packets on mid " + mid + " (" + lost + " lost packets)");
								},
								onmessage: function(msg, jsep) {
									Janus.debug(" ::: Got a message :::", msg);
									if(jsep) {
										Janus.debug("Handling SDP as well...", jsep);
										echotest.handleRemoteJsep({ jsep: jsep });
									}
									let result = msg["result"];
									if(result) {
										if(result === "done") {
											// The plugin closed the echo test
											bootbox.alert("The Echo Test is over");
											$('video').remove();
											$('#waitingvideo').remove();
											$('#peervideo').remove();
											$('#toggleaudio').attr('disabled', true);
											$('#togglevideo').attr('disabled', true);
											$('#bitrate').attr('disabled', true);
											$('#curbitrate').addClass('hide');
											$('#curres').addClass('hide');
											return;
										}
										// Any loss?
										let status = result["status"];
										if(status === "slow_link") {
											toastr.warning("Janus apparently missed many packets we sent, maybe we should reduce the bitrate", "Packet loss?", {timeOut: 2000});
										}
									}
									// Is simulcast in place?
									let substream = msg["substream"];
									let temporal = msg["temporal"];
									if((substream !== null && substream !== undefined) || (temporal !== null && temporal !== undefined)) {
										if(!simulcastStarted) {
											simulcastStarted = true;
											addSimulcastButtons(msg["videocodec"] === "vp8");
										}
										// We just received notice that there's been a switch, update the buttons
										updateSimulcastButtons(substream, temporal);
									}
								},
								// eslint-disable-next-line no-unused-vars
								onlocaltrack: function(track, on) {
									// We ignore the stream we got here, we're using the canvas to render it
									if(echotest.webrtcStuff.pc.iceConnectionState !== "completed" &&
											echotest.webrtcStuff.pc.iceConnectionState !== "connected") {
										$("#videoleft").parent().block({
											message: '<b>Publishing...</b>',
											css: {
												border: 'none',
												backgroundColor: 'transparent',
												color: 'white'
											}
										});
									}
								},
								onremotetrack: function(track, mid, on, metadata) {
									Janus.debug(
										"Remote track (mid=" + mid + ") " +
										(on ? "added" : "removed") +
										(metadata? " (" + metadata.reason + ") " : "") + ":", track
									);
									if(!on) {
										// Track removed, get rid of the stream and the rendering
										$('#peervideo' + mid).remove();
										if(track.kind === "video") {
											remoteVideos--;
											if(remoteVideos === 0) {
												// No video, at least for now: show a placeholder
												if($('#videoright .no-video-container').length === 0) {
													$('#videoright').append(
														'<div class="no-video-container">' +
															'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
															'<span class="no-video-text">No remote video available</span>' +
														'</div>');
												}
											}
										}
										delete remoteTracks[mid];
										return;
									}
									// If we're here, a new track was added
									$('#spinner').remove();
									let addButtons = false;
									if($('#videoright audio').length === 0 && $('#videoright video').length === 0) {
										addButtons = true;
										$('#videos').removeClass('hide');
									}
									if(track.kind === "audio") {
										// New audio track: create a stream out of it, and use a hidden <audio> element
										stream = new MediaStream([track]);
										remoteTracks[mid] = stream;
										Janus.log("Created remote audio stream:", stream);
										if($('#peervideo'+mid).length === 0)
											$('#videoright').append('<audio class="hide" id="peervideo' + mid + '" autoplay playsinline/>');
										Janus.attachMediaStream($('#peervideo' + mid).get(0), stream);
										if(remoteVideos === 0) {
											// No video, at least for now: show a placeholder
											if($('#videoright .no-video-container').length === 0) {
												$('#videoright').append(
													'<div class="no-video-container">' +
														'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
														'<span class="no-video-text">No webcam available</span>' +
													'</div>');
											}
										}
									} else {
										// New video track: create a stream out of it
										remoteVideos++;
										$('#videoright .no-video-container').remove();
										stream = new MediaStream([track]);
										remoteTracks[mid] = stream;
										Janus.log("Created remote video stream:", stream);
										if($('#peervideo'+mid).length === 0)
											$('#videoright').append('<video class="rounded centered" id="peervideo' + mid + '" width="100%" height="100%" autoplay playsinline/>');
										Janus.attachMediaStream($('#peervideo' + mid).get(0), stream);
										// FIXME we'll need this for additional videos too
										if(!bitrateTimer) {
											$('#curbitrate').removeClass('hide');
											bitrateTimer = setInterval(function() {
												if(!$("#peervideo" + mid).get(0))
													return;
												// Display updated bitrate, if supported
												let bitrate = echotest.getBitrate();
												//~ Janus.debug("Current bitrate is " + echotest.getBitrate());
												$('#curbitrate').text(bitrate);
												// Check if the resolution changed too
												let width = $("#peervideo" + mid).get(0).videoWidth;
												let height = $("#peervideo" + mid).get(0).videoHeight;
												if(width > 0 && height > 0)
													$('#curres').removeClass('hide').text(width+'x'+height).removeClass('hide');
											}, 1000);
										}
									}
									if(!addButtons)
										return;
									// Enable audio/video buttons and bitrate limiter
									audioenabled = true;
									videoenabled = true;
									$('#toggleaudio').click(
										function() {
											audioenabled = !audioenabled;
											if(audioenabled)
												$('#toggleaudio').html("Disable audio").removeClass("btn-success").addClass("btn-danger");
											else
												$('#toggleaudio').html("Enable audio").removeClass("btn-danger").addClass("btn-success");
											echotest.send({ message: { audio: audioenabled }});
										});
									$('#togglevideo').click(
										function() {
											videoenabled = !videoenabled;
											if(videoenabled)
												$('#togglevideo').html("Disable video").removeClass("btn-success").addClass("btn-danger");
											else
												$('#togglevideo').html("Enable video").removeClass("btn-danger").addClass("btn-success");
											echotest.send({ message: { video: videoenabled }});
										});
									$('#toggleaudio').parent().removeClass('hide');
									$('#bitrate a').click(function() {
										$('.dropdown-toggle').dropdown('hide');
										let id = $(this).attr("id");
										let bitrate = parseInt(id)*1000;
										if(bitrate === 0) {
											Janus.log("Not limiting bandwidth via REMB");
										} else {
											Janus.log("Capping bandwidth to " + bitrate + " via REMB");
										}
										$('#bitrateset').text($(this).text()).parent().removeClass('open');
										echotest.send({ message: { bitrate: bitrate }});
										return false;
									});
								},
								oncleanup: function() {
									Janus.log(" ::: Got a cleanup notification :::");
									if(bitrateTimer)
										clearInterval(bitrateTimer);
									bitrateTimer = null;
									$('video').remove();
									$('#waitingvideo').remove();
									$("#videoleft").empty().parent().unblock();
									$('#videoright').empty();
									$('#toggleaudio').attr('disabled', true);
									$('#togglevideo').attr('disabled', true);
									$('#bitrate').attr('disabled', true);
									$('#curbitrate').addClass('hide');
									$('#curres').addClass('hide');
									simulcastStarted = false;
									$('#simulcast').remove();
									remoteTracks = {};
									remoteVideos = 0;
								}
							});
					},
					error: function(error) {
						Janus.error(error);
						bootbox.alert(error, function() {
							window.location.reload();
						});
					},
					destroyed: function() {
						window.location.reload();
					}
				});
		});
	}});
});

// eslint-disable-next-line no-unused-vars
function checkEnter(event) {
	let theCode = event.keyCode ? event.keyCode : event.which ? event.which : event.charCode;
	if(theCode == 13) {
		updateCanvas();
		return false;
	} else {
		return true;
	}
}

// Helper function to create (and populate) our canvas element
function createCanvas() {
	// Predefined tweaks
	$('#text').val(myText);
	$('#color').val(myColor);
	$('#font').val(myFont);
	$('#posX').val(""+myX);
	$('#posY').val(""+myY);
	// Capture the local webcam
	navigator.mediaDevices.getUserMedia(
		{
			audio: true,
			video: {
				width: { ideal: 640 },
				height: { ideal: 480 }
			}
		})
		.then(function(stream) {
			// We have our video
			Janus.debug(stream);
			Janus.attachMediaStream($('#canvasvideo').get(0), stream);
			$('#canvasvideo').get(0).muted = "muted";
			$('#canvasvideo').get(0).play();
			// Let's setup the canvas, now
			$('#canvasvideo').get(0).addEventListener('play', function () {
				let myvideo = this;
				let canvas = document.getElementById('canvas');
				let context = canvas.getContext('2d');
				let logo = new Image();
				logo.onload = function() {
					(function loop() {
						if(!myvideo.paused && !myvideo.ended) {
							// Copy video to image
							context.drawImage(myvideo, 0, 0);
							// Add logo
							context.drawImage(logo,
								0, 0, logoW, logoH,
								logoX, logoY, logoW*logoS, logoH*logoS);
							// Add some text
							context.fillStyle = 'rgba(0,0,0,0.5)';
							context.fillRect(0, 420, 640, 480);
							context.font = myFont;
							context.fillStyle = myColor;
							context.fillText(myText, myX, myY);
							// We're drawing at the specified fps
							setTimeout(loop, 1000 / fps);
						}
					})();
				};
				logo.src = logoUrl;
				// Capture the canvas as a local MediaStream
				canvasStream = canvas.captureStream();
				canvasStream.addTrack(stream.getAudioTracks()[0]);
				Janus.attachMediaStream($('#myvideo').get(0), canvasStream);
				$('#myvideo').get(0).muted = "muted";
				$('#myvideo').get(0).play();
				$('#myvideo').removeClass('hide');
				// Now that the stream is ready, we can create the PeerConnection
				let body = { audio: true, video: true };
				// We can try and force a specific codec, by telling the plugin what we'd prefer
				// For simplicity, you can set it via a query string (e.g., ?vcodec=vp9)
				if(acodec)
					body["audiocodec"] = acodec;
				if(vcodec)
					body["videocodec"] = vcodec;
				// For the codecs that support them (VP9 and H.264) you can specify a codec
				// profile as well (e.g., ?vprofile=2 for VP9, or ?vprofile=42e01f for H.264)
				if(vprofile)
					body["videoprofile"] = vprofile;
				Janus.debug("Sending message:", body);
				echotest.send({ message: body });
				Janus.debug("Trying a createOffer too (audio/video sendrecv)");
				// We need to pass the canvas MediaStream tracks we
				// captured here, so we tell janus.js to use those
				let canvasTracks = [];
				if(canvasStream.getAudioTracks().length > 0)
					canvasTracks.push({ type: 'audio', capture: canvasStream.getAudioTracks()[0], recv: true });
				if(canvasStream.getVideoTracks().length > 0)
					canvasTracks.push({ type: 'video', capture: canvasStream.getVideoTracks()[0], recv: true });
				Janus.warn(canvasTracks);
				echotest.createOffer(
					{
						tracks: canvasTracks,
						success: function(jsep) {
							Janus.debug("Got SDP!", jsep);
							echotest.send({ message: body, jsep: jsep });
							// Create a spinner waiting for the remote video
							$('#videoright').html(
								'<div class="text-center">' +
								'	<div id="spinner" class="spinner-border" role="status">' +
								'		<span class="visually-hidden">Loading...</span>' +
								'	</div>' +
								'</div>');
						},
						error: function(error) {
							Janus.error("WebRTC error:", error);
							bootbox.alert("WebRTC error... " + error.message);
						}
					});

			}, 0);
		})
		.catch(function(error) {
			Janus.error(error);
			bootbox.alert(error);
		});
}
// Helper function to update a canvas when the tweaks are used
function updateCanvas() {
	myText = $('#text').val();
	myColor = $('#color').val();
	myFont = $('#font').val();
	myX = parseInt($('#posX').val());
	myY = parseInt($('#posY').val());
}


// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[[]/, "\\[").replace(/[\]]/, "\\]");
	let regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}

// Helpers to create Simulcast-related UI, if enabled
function addSimulcastButtons(temporal) {
	$('#curres').parent().append(
		'<div id="simulcast" class="btn-group-vertical btn-group-xs top-right">' +
		'	<div class="btn-group btn-group-xs d-flex" style="width: 100%">' +
		'		<button id="sl-2" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to higher quality">SL 2</button>' +
		'		<button id="sl-1" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to normal quality">SL 1</button>' +
		'		<button id="sl-0" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to lower quality">SL 0</button>' +
		'	</div>' +
		'	<div class="btn-group btn-group-xs d-flex hide" style="width: 100%">' +
		'		<button id="tl-2" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 2">TL 2</button>' +
		'		<button id="tl-1" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 1">TL 1</button>' +
		'		<button id="tl-0" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 0">TL 0</button>' +
		'	</div>' +
		'</div>');
	if(Janus.webRTCAdapter.browserDetails.browser !== "firefox") {
		// Chromium-based browsers only have two temporal layers
		$('#tl-2').remove();
	}
	// Enable the simulcast selection buttons
	$('#sl-0').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching simulcast substream, wait for it... (lower quality)", null, {timeOut: 2000});
			if(!$('#sl-2').hasClass('btn-success'))
				$('#sl-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#sl-1').hasClass('btn-success'))
				$('#sl-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#sl-0').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			echotest.send({ message: { substream: 0 }});
		});
	$('#sl-1').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching simulcast substream, wait for it... (normal quality)", null, {timeOut: 2000});
			if(!$('#sl-2').hasClass('btn-success'))
				$('#sl-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#sl-1').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#sl-0').hasClass('btn-success'))
				$('#sl-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			echotest.send({ message: { substream: 1 }});
		});
	$('#sl-2').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching simulcast substream, wait for it... (higher quality)", null, {timeOut: 2000});
			$('#sl-2').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#sl-1').hasClass('btn-success'))
				$('#sl-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#sl-0').hasClass('btn-success'))
				$('#sl-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			echotest.send({ message: { substream: 2 }});
		});
	if(!temporal)	// No temporal layer support
		return;
	$('#tl-0').parent().removeClass('hide');
	$('#tl-0').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping simulcast temporal layer, wait for it... (lowest FPS)", null, {timeOut: 2000});
			if(!$('#tl-2').hasClass('btn-success'))
				$('#tl-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#tl-1').hasClass('btn-success'))
				$('#tl-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#tl-0').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			echotest.send({ message: { temporal: 0 }});
		});
	$('#tl-1').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping simulcast temporal layer, wait for it... (medium FPS)", null, {timeOut: 2000});
			if(!$('#tl-2').hasClass('btn-success'))
				$('#tl-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#tl-1').removeClass('btn-primary btn-info').addClass('btn-info');
			if(!$('#tl-0').hasClass('btn-success'))
				$('#tl-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			echotest.send({ message: { temporal: 1 }});
		});
	$('#tl-2').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping simulcast temporal layer, wait for it... (highest FPS)", null, {timeOut: 2000});
			$('#tl-2').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#tl-1').hasClass('btn-success'))
				$('#tl-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#tl-0').hasClass('btn-success'))
				$('#tl-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			echotest.send({ message: { temporal: 2 }});
		});
}

function updateSimulcastButtons(substream, temporal) {
	// Check the substream
	if(substream === 0) {
		toastr.success("Switched simulcast substream! (lower quality)", null, {timeOut: 2000});
		$('#sl-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl-0').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
	} else if(substream === 1) {
		toastr.success("Switched simulcast substream! (normal quality)", null, {timeOut: 2000});
		$('#sl-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl-1').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#sl-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	} else if(substream === 2) {
		toastr.success("Switched simulcast substream! (higher quality)", null, {timeOut: 2000});
		$('#sl-2').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#sl-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	}
	// Check the temporal layer
	if(temporal === 0) {
		toastr.success("Capped simulcast temporal layer! (lowest FPS)", null, {timeOut: 2000});
		$('#tl-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl-0').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
	} else if(temporal === 1) {
		toastr.success("Capped simulcast temporal layer! (medium FPS)", null, {timeOut: 2000});
		$('#tl-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl-1').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#tl-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	} else if(temporal === 2) {
		toastr.success("Capped simulcast temporal layer! (highest FPS)", null, {timeOut: 2000});
		$('#tl-2').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#tl-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	}
}
