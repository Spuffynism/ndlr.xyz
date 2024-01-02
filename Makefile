run:
	hugo server

IP_ADDRESS := $(shell ipconfig getifaddr en0)
preview-mobile:
	hugo server \
	  --bind ${IP_ADDRESS} \
	  --baseURL http://${IP_ADDRESS}