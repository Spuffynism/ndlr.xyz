import Head from 'next/head'
import Name from "@/pages/components/Name";
import { Inter } from 'next/font/google'
/*import { EffectComposer, Noise } from '@react-three/postprocessing'*/
const inter = Inter({ subsets: ['latin'] })
export default function Home() {
  return (
    <>
      <Head>
        <title>nico</title>
        <meta name="description" content="nico" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="theme-color" content="#000000" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <main id="root">
        <div style={{...inter.style, padding: '1em', position: 'absolute'}}>
          <div style={{fontSize: '5em'}}>My name is Nico. I am a senior software developer.</div>
          <p style={{fontSize: '2em'}}>Find me here, or on the internet.<br/><br/>
            My code is <a href="https://github.com/Spuffynism" target="_blank">here</a>.<br/>
            My twitter is <a href="https://x.com/ndlabarre" target="_blank">here</a>.<br/>
            My linkedin is <a href="https://www.linkedin.com/in/nlabarre/" target="_blank">here</a>.<br/><br/>
            I can be reached at nico@[this-domain-name].
          </p>
          <hr/>
        </div>
        <Name/>
      </main>
      {/*<main>
        <p>Find me here, or anywhere else on the internet.<br/><br/>
          My repos are <a href="https://github.com/Spuffynism" target="_blank">here</a>.<br/>
          My gists are <a href="https://gist.github.com/Spuffynism" target="_blank">here</a>.<br/>
          My linkedin is <a href="https://www.linkedin.com/in/nlabarre/" target="_blank">here</a>.<br/><br/>
          I can be reached at nico@[this-domain-name].
        </p>
        <Name />
      </main>*/}
    </>
  )
}
