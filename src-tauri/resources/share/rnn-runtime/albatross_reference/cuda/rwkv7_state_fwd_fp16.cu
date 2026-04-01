#include <stdio.h>
#include <assert.h>
#include "ATen/ATen.h"
#include <ATen/cuda/CUDAContext.h>

typedef at::Half dtype;

template <int N, typename F> __launch_bounds__(N, 2)
__global__ void kernel_forward(const int B, const int T, const int C, const int H,
                               float *__restrict__ _state, const F *__restrict__ const _r, const F *__restrict__ const _w, const F *__restrict__ const _k, const F *__restrict__ const _v,
                               const F *__restrict__ const _a, const F *__restrict__ const _b, F *__restrict__ const _y)
{
    const int bbb = blockIdx.x / H;
    const int h = blockIdx.x % H;
    const int i = threadIdx.x;
    _state += bbb*C*N + h*N*N + i*N;

    float state[N];
    #pragma unroll
    for (int j = 0; j < N; ++j)
        state[j] = _state[j];

    __shared__ float r[N];
    __shared__ float w[N];
    __shared__ float k[N];
    __shared__ float a[N];
    __shared__ float b[N];

    for (int _t = 0; _t < T; ++_t)
    {
        const int t = bbb*T*C + h*N + i + _t * C;
        __syncthreads();
        r[i] = float(_r[t]);
        w[i] = __expf(-0.6065306597f * float(_w[t])); // 0.6065306597 = exp(-0.5)
        k[i] = float(_k[t]);
        a[i] = float(_a[t]);
        b[i] = float(_b[t]);
        __syncthreads();

        float sa = 0.0f;
        #pragma unroll
        for (int j = 0; j < N; ++j)
            sa += state[j] * a[j];

        const float vi = float(_v[t]);
        float y = 0.0f;
        #pragma unroll
        for (int j = 0; j < N; ++j)
        {
            float s = state[j];
            s = s * w[j] + (sa * b[j] + k[j] * vi);
            y += s * r[j];
            state[j] = s;
        }
        _y[t] = F(y);
    }
    #pragma unroll
    for (int j = 0; j < N; ++j)
        _state[j] = state[j];
}

void cuda_forward(int B, int T, int C, int H, float *state, dtype *r, dtype *w, dtype *k, dtype *v, dtype *a, dtype *b, dtype *y)
{
    constexpr int N = _N_;
    assert(H*N == C);
    auto stream = at::cuda::getCurrentCUDAStream();
    kernel_forward<N, dtype><<<dim3(B * H), dim3(N), 0, stream>>>(B, T, C, H, state, r, w, k, v, a, b, y);
}
