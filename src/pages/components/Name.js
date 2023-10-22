import { Canvas } from '@react-three/fiber'
import {
  Icosahedron,
  MeshDistortMaterial, OrbitControls
} from '@react-three/drei'
import { Inter } from 'next/font/google'
import {useRef, useState} from "react";
/*import { EffectComposer, Noise } from '@react-three/postprocessing'*/
const inter = Inter({ subsets: ['latin'] })

export default function Name() {
  return (
    <Canvas>
      <pointLight position={[-10, -10, -10]} />
      <ambientLight intensity={1} />
      <OrbitControls enableZoom={false} enablePan={false} />
      <MovingBlob position={[0, 0, 0]} color={'#313131'} args={[1.25, 10]}/>
      {/*<EffectComposer multisampling={0} disableNormalPass={true}>
        <Noise opacity={0.15} />
      </EffectComposer>*/}
    </Canvas>
  )
}

const MovingBlob = ({color, speed = 1, ...props}) => {
  const ref = useRef()
  const [hovered, hover] = useState(false)

  return (
    <Icosahedron
      {...props}
      ref={ref}
      onPointerOver={(event) => (event.stopPropagation(), hover(true))}
      onPointerOut={(event) => hover(false)}>
      <MeshDistortMaterial
        color={hovered ? 'hotpink' : color}
        speed={speed}
        distort={0.6}
        radius={1}
        wireframe
      />
    </Icosahedron>
  )
}
